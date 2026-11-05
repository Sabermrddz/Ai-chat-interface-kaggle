'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'kaggle_chat_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 512;

function configuredPassword() {
  return String(process.env.ACCESS_PASSWORD || '').trim();
}

function authRequired() {
  return Boolean(configuredPassword());
}

function configuredSessionSecret() {
  return String(process.env.SESSION_SECRET || '').trim();
}

function deriveKey(password) {
  const sessionSecret = configuredSessionSecret();
  const keyMaterial = sessionSecret
    ? `kaggle-chat-session\0${sessionSecret}`
    : `kaggle-chat-auth\0${password}\0${String(process.env.BRIDGE_TOKEN || '').trim()}`;

  return crypto.createHash('sha256').update(keyMaterial).digest();
}

function sign(value, password) {
  return crypto.createHmac('sha256', deriveKey(password)).update(value).digest('hex');
}

function signaturesMatch(provided, expected) {
  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function passwordsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) {
    return false;
  }

  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function createSessionToken(password, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  const expiresAt = now + ttlMs;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${sign(payload, password)}`;
}

function verifySessionToken(token, password, now = Date.now()) {
  if (typeof token !== 'string' || typeof password !== 'string' || !password) {
    return false;
  }

  const match = token.match(/^v1\.(\d+)\.([a-f0-9]{64})$/);
  if (!match) {
    return false;
  }

  const expiresAt = Number(match[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return false;
  }

  const payload = `v1.${match[1]}`;
  return signaturesMatch(match[2], sign(payload, password));
}

function parseCookies(header) {
  const cookies = new Map();

  if (typeof header !== 'string' || !header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) {
      continue;
    }

    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }

  return cookies;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];

  if (process.env.NODE_ENV === 'production' || req.secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function isAuthenticated(req) {
  const password = configuredPassword();
  if (!password) {
    return true;
  }

  const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
  return verifySessionToken(token, password);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({ error: 'Authentication required.' });
}

function loginHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const password = configuredPassword();
  if (!password) {
    return res.json({ ok: true, required: false, authenticated: true });
  }

  const provided =
    req.body && typeof req.body.password === 'string' ? req.body.password : '';

  if (!provided) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  if (provided.length > MAX_PASSWORD_LENGTH || !passwordsMatch(provided, password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  setSessionCookie(req, res, createSessionToken(password));
  return res.json({ ok: true, required: true, authenticated: true });
}

function logoutHandler(req, res) {
  clearSessionCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true });
}

function statusHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    required: authRequired(),
    authenticated: isAuthenticated(req)
  });
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  MAX_PASSWORD_LENGTH,
  authRequired,
  configuredPassword,
  configuredSessionSecret,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  passwordsMatch,
  isAuthenticated,
  requireAuth,
  loginHandler,
  logoutHandler,
  statusHandler
};
