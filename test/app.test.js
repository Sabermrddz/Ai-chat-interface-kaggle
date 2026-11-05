'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const { after, before, test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const TEST_SECRET = 'test-secret-do-not-use-in-production';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      BRIDGE_TOKEN: TEST_SECRET,
      ACCESS_PASSWORD: '',
      SESSION_SECRET: '',
      ALLOWED_ORIGIN: '',
      BRIDGE_EXTRA_HOSTS: '',
      REQUEST_BODY_LIMIT: '',
      TRUST_PROXY: '',
      MODEL_API_URL: '',
      MODEL_NAME: '',
      STATUS_PING_TIMEOUT_MS: '150',
      UPSTREAM_CONNECT_TIMEOUT_MS: '500',
      UPSTREAM_IDLE_TIMEOUT_MS: '500',
      SSE_KEEPALIVE_MS: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  return {
    child,
    port,
    output: () => output
  };
}

async function waitForServer(server, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${server.output()}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      if (response.ok) {
        return;
      }
    } catch {}

    await wait(100);
  }

  throw new Error(`Server did not become ready in time.\n${server.output()}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) {
    return;
  }

  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    wait(3_000).then(() => {
      if (server.child.exitCode === null) {
        server.child.kill();
      }
    })
  ]);
}

async function postJson(port, pathName, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

let offlineServer;
let bridgeServer;

before(async () => {
  const offlinePort = await getFreePort();
  let bridgePort = await getFreePort();
  while (bridgePort === offlinePort) {
    bridgePort = await getFreePort();
  }
  offlineServer = startServer(offlinePort, {});
  bridgeServer = startServer(bridgePort, {});
  await Promise.all([waitForServer(offlineServer), waitForServer(bridgeServer)]);
});

after(async () => {
  await Promise.all([stopServer(offlineServer), stopServer(bridgeServer)]);
});

test('GET /health returns ok', async () => {
  const response = await fetch(`http://127.0.0.1:${offlineServer.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /api/status is offline without a registered bridge', async () => {
  const response = await fetch(`http://127.0.0.1:${offlineServer.port}/api/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    online: false,
    model: null,
    lastSeen: null,
    source: null
  });
});

test('POST /api/chat rejects an empty message', async () => {
  const response = await postJson(offlineServer.port, '/api/chat', {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /type a message/i);
});

test('POST /api/chat rejects invalid message roles', async () => {
  const response = await postJson(offlineServer.port, '/api/chat', {
    messages: [{ role: 'hacker', content: 'hello' }]
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /roles must be/i);
});

test('POST /api/chat returns 503 when the Kaggle notebook is offline', async () => {
  const response = await postJson(offlineServer.port, '/api/chat', {
    messages: [{ role: 'user', content: 'Hello there' }],
    stream: true
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Kaggle notebook is offline/i);
});

test('bridge registration validates the token and tunnel URL', async () => {
  const missingToken = await postJson(bridgeServer.port, '/api/bridge/register', {
    url: 'https://test.trycloudflare.com',
    model: 'test-model'
  });
  assert.equal(missingToken.status, 401);

  const wrongToken = await postJson(bridgeServer.port, '/api/bridge/register', {
    url: 'https://test.trycloudflare.com',
    model: 'test-model',
    token: 'wrong-secret'
  });
  assert.equal(wrongToken.status, 401);

  const wrongHost = await postJson(bridgeServer.port, '/api/bridge/register', {
    url: 'https://example.com',
    model: 'test-model',
    token: TEST_SECRET
  });
  assert.equal(wrongHost.status, 400);
  assert.match((await wrongHost.json()).error, /trycloudflare/i);

  const accepted = await postJson(bridgeServer.port, '/api/bridge/register', {
    url: 'https://test.trycloudflare.com',
    model: 'test-model',
    token: TEST_SECRET
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, model: 'test-model' });
});

test('status uses heartbeat metadata and fails the live ping', async () => {
  const response = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/status`);
  assert.equal(response.status, 200);

  const status = await response.json();
  assert.equal(status.online, false);
  assert.equal(status.model, 'test-model');
  assert.equal(status.source, 'heartbeat');
  assert.equal(typeof status.lastSeen, 'string');
  assert.ok(!Number.isNaN(Date.parse(status.lastSeen)));
});

test('registered but unreachable bridge returns a friendly gateway error', async () => {
  const response = await postJson(bridgeServer.port, '/api/chat', {
    messages: [{ role: 'user', content: 'Hello there' }],
    stream: true
  });

  assert.ok([502, 504].includes(response.status));
  assert.match((await response.json()).error, /Kaggle notebook/i);
});

test('manual bridge setup requires admin authorization', async () => {
  const unauthorized = await postJson(bridgeServer.port, '/api/bridge/manual', {
    url: 'http://127.0.0.1:1',
    model: 'manual-model'
  });
  assert.equal(unauthorized.status, 401);

  const wrongToken = await postJson(
    bridgeServer.port,
    '/api/bridge/manual',
    { url: 'http://127.0.0.1:1', model: 'manual-model' },
    { Authorization: 'Bearer wrong-secret' }
  );
  assert.equal(wrongToken.status, 401);

  const accepted = await postJson(
    bridgeServer.port,
    '/api/bridge/manual',
    { url: 'http://127.0.0.1:1', model: 'manual-model' },
    { Authorization: `Bearer ${TEST_SECRET}` }
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, model: 'manual-model' });
});

test('registration accepts the shared secret as a bearer header', async () => {
  const response = await postJson(
    bridgeServer.port,
    '/api/bridge/register',
    { url: 'https://header.trycloudflare.com', model: 'header-model' },
    { Authorization: `Bearer ${TEST_SECRET}` }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, model: 'header-model' });
});
