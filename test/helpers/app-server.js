'use strict';

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

const ROOT = path.join(__dirname, '..', '..');
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

function baseEnvironment(extraEnv) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    HOST: '127.0.0.1',
    BRIDGE_TOKEN: TEST_SECRET,
    ADMIN_TOKEN: '',
    ACCESS_PASSWORD: '',
    ALLOWED_ORIGIN: '',
    MODEL_API_URL: '',
    MODEL_NAME: '',
    MODEL_API_KEY: '',
    BRIDGE_EXTRA_HOSTS: '',
    REQUEST_BODY_LIMIT: '',
    TRUST_PROXY: '',
    STATUS_PING_TIMEOUT_MS: '150',
    UPSTREAM_CONNECT_TIMEOUT_MS: '500',
    UPSTREAM_IDLE_TIMEOUT_MS: '500',
    ...extraEnv
  };
}

function spawnServer(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...baseEnvironment(extraEnv),
      PORT: String(port)
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
        return server;
      }
    } catch {}

    await wait(100);
  }

  throw new Error(`Server did not become ready in time.\n${server.output()}`);
}

async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const server = spawnServer(port, extraEnv);
  return waitForServer(server);
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

async function postJson(server, pathName, body, headers = {}) {
  const port = typeof server === 'number' ? server : server.port;
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function sessionCookie(response) {
  const cookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

function setCookieHeaders(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
}

async function configureManualBridge(server, { url, model, token } = {}) {
  return postJson(
    server,
    '/api/bridge/manual',
    { url, model, token },
    { Authorization: `Bearer ${TEST_SECRET}` }
  );
}

module.exports = {
  ROOT,
  TEST_SECRET,
  getFreePort,
  startServer,
  stopServer,
  postJson,
  sessionCookie,
  setCookieHeaders,
  configureManualBridge
};
