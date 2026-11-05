'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  TEST_SECRET,
  postJson,
  sessionCookie,
  setCookieHeaders,
  startServer,
  stopServer
} = require('./helpers/app-server');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery staple';

function read(fileName) {
  return fs.readFileSync(path.join(ROOT, fileName), 'utf8');
}

test('Heroku runtime configuration uses Node 22 and the Procfile command', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines.node, '22.x');
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(read('Procfile').trim(), 'web: node server.js');
});

test('README documents the Heroku deployment and H12 limits', () => {
  const readme = read('README.md');

  assert.match(readme, /### Deploy to Heroku/);
  assert.match(readme, /heroku create/);
  assert.match(readme, /heroku config:set BRIDGE_TOKEN=/);
  assert.match(readme, /heroku config:set ALLOWED_ORIGIN=/);
  assert.match(readme, /heroku config:set TRUST_PROXY=1/);
  assert.match(readme, /heroku config:set ACCESS_PASSWORD=/);
  assert.match(readme, /heroku config:set NODE_ENV=production/);
  assert.match(readme, /git push heroku master/);
  assert.match(readme, /heroku logs --tail/);
  assert.match(readme, /Eco dyno is paid/i);
  assert.match(readme, /exactly one Eco web dyno/i);
  assert.match(readme, /30 seconds/i);
  assert.match(readme, /H12/);
  assert.match(readme, /KAGGLE_BRIDGE_TOKEN/);
  assert.match(readme, /heartbeat.*keeps.*awake/i);
  assert.match(readme, /does not write to disk/i);
});

test('environment template documents session secrets and SSE keep-alive', () => {
  const env = read('.env.example');
  assert.match(env, /SESSION_SECRET=/);
  assert.match(env, /SSE_KEEPALIVE_MS=/);
});

test('startup logs which secrets are configured without printing them', async () => {
  const server = await startServer({
    NODE_ENV: 'production',
    BRIDGE_TOKEN: TEST_SECRET,
    ALLOWED_ORIGIN: 'https://example.invalid',
    ACCESS_PASSWORD: PASSWORD
  });

  try {
    const output = server.output();
    assert.match(output, /BRIDGE_TOKEN=true/);
    assert.match(output, /ALLOWED_ORIGIN=true/);
    assert.match(output, /ACCESS_PASSWORD=true/);
    assert.doesNotMatch(output, new RegExp(TEST_SECRET));
    assert.doesNotMatch(output, new RegExp(PASSWORD));
    assert.doesNotMatch(output, /ACCESS_PASSWORD is not set/);
  } finally {
    await stopServer(server);
  }
});

test('production warns when ACCESS_PASSWORD is missing', async () => {
  const server = await startServer({
    NODE_ENV: 'production',
    ACCESS_PASSWORD: ''
  });

  try {
    const output = server.output();
    assert.match(output, /ACCESS_PASSWORD is not set/);
    assert.match(output, /ACCESS_PASSWORD=false/);
  } finally {
    await stopServer(server);
  }
});

test('SESSION_SECRET signs sessions independently of the password', async () => {
  const first = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    SESSION_SECRET: 'session-secret-one',
    BRIDGE_TOKEN: 'bridge-token-one'
  });
  const second = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    SESSION_SECRET: 'session-secret-two',
    BRIDGE_TOKEN: 'bridge-token-one'
  });

  try {
    const login = await postJson(first, '/api/auth/login', {
      password: PASSWORD
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login);

    const accepted = await fetch(
      `http://127.0.0.1:${first.port}/api/status`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(accepted.status, 200);

    const rejected = await fetch(
      `http://127.0.0.1:${second.port}/api/status`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(rejected.status, 401);
  } finally {
    await Promise.all([stopServer(first), stopServer(second)]);
  }
});

test('the fallback session key includes BRIDGE_TOKEN', async () => {
  const first = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    SESSION_SECRET: '',
    BRIDGE_TOKEN: 'bridge-token-one'
  });
  const second = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    SESSION_SECRET: '',
    BRIDGE_TOKEN: 'bridge-token-two'
  });

  try {
    const login = await postJson(first, '/api/auth/login', {
      password: PASSWORD
    });
    assert.equal(login.status, 200);

    const rejected = await fetch(
      `http://127.0.0.1:${second.port}/api/status`,
      { headers: { Cookie: sessionCookie(login) } }
    );
    assert.equal(rejected.status, 401);
  } finally {
    await Promise.all([stopServer(first), stopServer(second)]);
  }
});

test('TRUST_PROXY uses forwarded client IPs and marks HTTPS cookies Secure', async () => {
  const server = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    TRUST_PROXY: '1'
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await postJson(
        server,
        '/api/auth/login',
        { password: 'wrong-password' },
        { 'X-Forwarded-For': '203.0.113.10' }
      );
      assert.equal(rejected.status, 401);
    }

    const accepted = await postJson(
      server,
      '/api/auth/login',
      { password: PASSWORD },
      {
        'X-Forwarded-For': '203.0.113.11',
        'X-Forwarded-Proto': 'https'
      }
    );

    assert.equal(accepted.status, 200);
    assert.match(setCookieHeaders(accepted)[0], /Secure/);
  } finally {
    await stopServer(server);
  }
});
