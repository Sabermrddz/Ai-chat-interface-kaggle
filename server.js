'use strict';

const path = require('path');
const express = require('express');

function loadLocalEnv() {
  if (typeof process.loadEnvFile !== 'function') {
    return;
  }

  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not load .env:', error.message);
    }
  }
}

loadLocalEnv();

const {
  BridgeError,
  initBridgeFromEnv,
  registerBridge,
  setManualBridge,
  getStatus,
  adminAuthConfigured,
  isAdminRequest
} = require('./lib/bridge');
const { chatHandler } = require('./lib/chat-proxy');
const { createRateLimiter } = require('./lib/rate-limit');
const {
  loginHandler,
  logoutHandler,
  requireAuth,
  statusHandler
} = require('./lib/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '256kb';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
}

function corsMiddleware(req, res, next) {
  const origin = req.get('origin');

  if (!origin) {
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  }

  let isAllowed = false;

  if (ALLOWED_ORIGINS.length > 0) {
    isAllowed = ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''));
  } else {
    try {
      isAllowed = new URL(origin).host === req.get('host');
    } catch {
      isAllowed = false;
    }
  }

  if (!isAllowed) {
    if (req.method === 'OPTIONS') {
      return res.status(403).end();
    }
    return res.status(403).json({ error: 'This origin is not allowed.' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Admin-Token'
    );
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  return next();
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });

  next();
}

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(requestLogger);
app.use(express.json({ limit: BODY_LIMIT }));

const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests. Please wait a moment and try again.'
});
const chatLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Too many chat requests. Please wait a moment and try again.'
});
const registerLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many bridge registrations. Please wait a moment.'
});
const loginLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Too many login attempts. Please wait a minute and try again.'
});

app.use('/api', apiLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/status', statusHandler);
app.post('/api/auth/login', loginLimiter, loginHandler);
app.post('/api/auth/logout', logoutHandler);

app.get('/api/status', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const status = await getStatus();
    return res.json(status);
  } catch {
    console.error('Status check failed unexpectedly.');
    return res.status(500).json({ error: 'Could not check the model status.' });
  }
});

app.post('/api/bridge/register', registerLimiter, (req, res) => {
  try {
    const result = registerBridge(req.body, req.get('authorization'));
    const modelLabel = result.model ? ` for "${result.model}"` : '';
    console.log(`Bridge heartbeat accepted${modelLabel}.`);
    return res.json({ ok: true, model: result.model });
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.statusCode >= 500) {
        console.error('Bridge registration is unavailable.');
      } else {
        console.warn(`Bridge registration rejected with HTTP ${error.statusCode}.`);
      }
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error('Bridge registration failed unexpectedly.');
    return res.status(500).json({ error: 'Could not register the bridge.' });
  }
});

app.post('/api/bridge/manual', (req, res) => {
  if (!adminAuthConfigured()) {
    return res.status(503).json({
      error: 'Manual bridge setup is disabled. Set ADMIN_TOKEN or BRIDGE_TOKEN first.'
    });
  }

  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Admin authorization is required.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = setManualBridge({
      url: body.url,
      model: body.model,
      token: body.token
    });
    const modelLabel = result.model ? ` for "${result.model}"` : '';
    console.log(`Manual bridge configured${modelLabel}.`);
    return res.json({ ok: true, model: result.model });
  } catch (error) {
    if (error instanceof BridgeError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error('Manual bridge setup failed unexpectedly.');
    return res.status(500).json({ error: 'Could not configure the manual bridge.' });
  }
});

app.post('/api/chat', requireAuth, chatLimiter, (req, res, next) => {
  Promise.resolve(chatHandler(req, res)).catch(next);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large.' });
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  console.error('Unhandled request error:', error?.name || 'Error');

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ error: 'Something went wrong.' });
});

initBridgeFromEnv();

const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Server is running on http://${displayHost}:${PORT}`);

  if (!process.env.BRIDGE_TOKEN) {
    console.warn('BRIDGE_TOKEN is not set. Notebook heartbeats will be rejected.');
  }

  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      'ALLOWED_ORIGIN is not set. Only same-host browser origins are allowed. Set it in production.'
    );
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the current server or start this app on a different port with PORT=3001 npm start.`
    );
    process.exit(1);
  }

  console.error('Server error:', error.name || 'Error');
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down...`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
