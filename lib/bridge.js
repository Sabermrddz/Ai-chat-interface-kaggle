'use strict';

const crypto = require('crypto');

const HEARTBEAT_TTL_MS = 90_000;
const PING_CACHE_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 4_000;

class BridgeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BridgeError';
    this.statusCode = statusCode;
  }
}

function readPositiveInt(raw, fallback, min = 100, max = 120_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const PING_TIMEOUT_MS = readPositiveInt(
  process.env.STATUS_PING_TIMEOUT_MS,
  DEFAULT_PING_TIMEOUT_MS,
  100,
  30_000
);

const bridgeState = {
  tunnelUrl: null,
  modelName: null,
  modelToken: null,
  lastSeen: null,
  source: null
};

let pingCache = null;
let pingInFlight = null;

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '');
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function normalizeBaseUrl(raw, { allowLocalHttp = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BridgeError('A tunnel URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BridgeError('The tunnel URL is not a valid URL.');
  }

  if (parsed.username || parsed.password) {
    throw new BridgeError('The tunnel URL must not contain credentials.');
  }

  if (parsed.protocol !== 'https:') {
    const isAllowedLocalHttp =
      parsed.protocol === 'http:' && allowLocalHttp && isLoopbackHostname(parsed.hostname);
    if (!isAllowedLocalHttp) {
      throw new BridgeError('The tunnel URL must use https (http is only allowed for localhost).');
    }
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new BridgeError('Use the tunnel base URL only, without a path such as /v1.');
  }

  parsed.search = '';
  parsed.hash = '';
  return trimTrailingSlashes(parsed.toString());
}

function isQuickTunnelUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const extraHosts = String(process.env.BRIDGE_EXTRA_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);

    const isCloudflareQuickTunnel =
      !parsed.port &&
      hostname.length > '.trycloudflare.com'.length &&
      hostname.endsWith('.trycloudflare.com');

    return (
      isCloudflareQuickTunnel ||
      extraHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function bearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return '';
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function cleanModelName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim().replace(/\s+/g, ' ').slice(0, 200);
  return cleaned || null;
}

function initBridgeFromEnv() {
  const rawUrl = process.env.MODEL_API_URL;
  if (!rawUrl) {
    return;
  }

  try {
    bridgeState.tunnelUrl = normalizeBaseUrl(rawUrl, { allowLocalHttp: true });
    bridgeState.modelName = cleanModelName(process.env.MODEL_NAME);
    bridgeState.modelToken =
      (process.env.MODEL_API_KEY || '').trim() || (process.env.BRIDGE_TOKEN || '').trim() || null;
    bridgeState.lastSeen = null;
    bridgeState.source = 'env';
    console.log('Manual model URL configured from MODEL_API_URL.');
  } catch (error) {
    console.error('MODEL_API_URL is invalid and was ignored:', error.message);
  }
}

function registerBridge(payload, authorizationHeader) {
  const expectedSecret = (process.env.BRIDGE_TOKEN || '').trim();

  if (!expectedSecret) {
    throw new BridgeError(
      'Bridge registration is disabled because BRIDGE_TOKEN is not set on the website.',
      503
    );
  }

  const bodyToken = typeof payload?.token === 'string' ? payload.token.trim() : '';
  const providedToken = bodyToken || bearerToken(authorizationHeader);

  if (!secretsMatch(providedToken, expectedSecret)) {
    throw new BridgeError('Invalid bridge token.', 401);
  }

  const tunnelUrl = normalizeBaseUrl(payload?.url);
  if (!isQuickTunnelUrl(tunnelUrl)) {
    throw new BridgeError(
      'Only Cloudflare quick tunnel URLs (*.trycloudflare.com) are accepted.',
      400
    );
  }

  bridgeState.tunnelUrl = tunnelUrl;
  bridgeState.modelName = cleanModelName(payload?.model);
  bridgeState.modelToken = expectedSecret;
  bridgeState.lastSeen = Date.now();
  bridgeState.source = 'heartbeat';
  pingCache = null;

  return { model: bridgeState.modelName };
}

function setManualBridge({ url, model, token }) {
  const tunnelUrl = normalizeBaseUrl(url, { allowLocalHttp: true });
  const modelToken =
    (typeof token === 'string' ? token.trim() : '') ||
    (process.env.MODEL_API_KEY || '').trim() ||
    (process.env.BRIDGE_TOKEN || '').trim() ||
    null;

  bridgeState.tunnelUrl = tunnelUrl;
  bridgeState.modelName = cleanModelName(model);
  bridgeState.modelToken = modelToken;
  bridgeState.lastSeen = Date.now();
  bridgeState.source = 'manual';
  pingCache = null;

  return { model: bridgeState.modelName };
}

function getUpstreamConfig() {
  if (!bridgeState.tunnelUrl) {
    return null;
  }

  return {
    baseUrl: bridgeState.tunnelUrl,
    modelName: bridgeState.modelName,
    modelToken: bridgeState.modelToken,
    lastSeen: bridgeState.lastSeen,
    source: bridgeState.source
  };
}

function isBridgeUsable() {
  if (!bridgeState.tunnelUrl) {
    return false;
  }

  if (bridgeState.source === 'heartbeat') {
    return Boolean(
      bridgeState.lastSeen && Date.now() - bridgeState.lastSeen <= HEARTBEAT_TTL_MS
    );
  }

  return true;
}

async function pingBridge() {
  const config = getUpstreamConfig();
  if (!config) {
    return { online: false, model: null };
  }

  const now = Date.now();
  if (
    pingCache &&
    pingCache.url === config.baseUrl &&
    now - pingCache.checkedAt < PING_CACHE_MS
  ) {
    return { online: pingCache.online, model: pingCache.model };
  }

  if (pingInFlight && pingInFlight.url === config.baseUrl) {
    return pingInFlight.promise;
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    try {
      const response = await fetch(`${config.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(config.modelToken
            ? { Authorization: `Bearer ${config.modelToken}` }
            : {})
        },
        signal: controller.signal
      });

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        return { online: false, model: null };
      }

      const data = await response.json().catch(() => null);
      const model =
        Array.isArray(data?.data) && typeof data.data[0]?.id === 'string'
          ? data.data[0].id
          : null;

      return { online: true, model };
    } catch {
      return { online: false, model: null };
    } finally {
      clearTimeout(timer);
    }
  })();

  pingInFlight = { url: config.baseUrl, promise };

  try {
    const result = await promise;
    pingCache = {
      url: config.baseUrl,
      checkedAt: Date.now(),
      online: result.online,
      model: result.model
    };
    return result;
  } finally {
    if (pingInFlight && pingInFlight.promise === promise) {
      pingInFlight = null;
    }
  }
}

async function getStatus() {
  const config = getUpstreamConfig();
  const lastSeen = config?.lastSeen ? new Date(config.lastSeen).toISOString() : null;

  if (!config) {
    return { online: false, model: null, lastSeen: null };
  }

  if (!isBridgeUsable()) {
    return {
      online: false,
      model: config.modelName || null,
      lastSeen
    };
  }

  const ping = await pingBridge();

  return {
    online: ping.online,
    model: config.modelName || ping.model || null,
    lastSeen
  };
}

async function resolveModelName() {
  const config = getUpstreamConfig();
  if (!config) {
    return null;
  }

  if (config.modelName) {
    return config.modelName;
  }

  const ping = await pingBridge();
  return ping.model || cleanModelName(process.env.MODEL_NAME) || 'default';
}

function adminAuthConfigured() {
  return Boolean((process.env.ADMIN_TOKEN || process.env.BRIDGE_TOKEN || '').trim());
}

function isAdminRequest(req) {
  const expected = (process.env.ADMIN_TOKEN || process.env.BRIDGE_TOKEN || '').trim();
  if (!expected) {
    return false;
  }

  const headerToken =
    bearerToken(req.get('authorization')) || String(req.get('x-admin-token') || '').trim();

  return secretsMatch(headerToken, expected);
}

module.exports = {
  BridgeError,
  initBridgeFromEnv,
  registerBridge,
  setManualBridge,
  getUpstreamConfig,
  isBridgeUsable,
  getStatus,
  resolveModelName,
  adminAuthConfigured,
  isAdminRequest
};
