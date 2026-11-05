'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const {
  postJson,
  sessionCookie,
  setCookieHeaders,
  startServer,
  stopServer
} = require('./helpers/app-server');

const PASSWORD = 'correct horse battery staple';

let server;

async function getStatus(cookie = '') {
  return fetch(`http://127.0.0.1:${server.port}/api/status`, {
    headers: cookie ? { Cookie: cookie } : {}
  });
}

before(async () => {
  server = await startServer({ ACCESS_PASSWORD: PASSWORD });
});

after(async () => {
  await stopServer(server);
});

test('auth status is public and reports when a password is required', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    required: true,
    authenticated: false
  });
});

test('status and chat require authentication when a password is set', async () => {
  const status = await getStatus();
  assert.equal(status.status, 401);
  assert.deepEqual(await status.json(), { error: 'Authentication required.' });

  const chat = await postJson(server, '/api/chat', {
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert.equal(chat.status, 401);
});

test('login rejects a wrong password and accepts the configured one', async () => {
  const rejected = await postJson(server, '/api/auth/login', {
    password: 'wrong-password'
  });
  assert.equal(rejected.status, 401);
  assert.match((await rejected.json()).error, /incorrect password/i);

  const accepted = await postJson(server, '/api/auth/login', {
    password: PASSWORD
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    required: true,
    authenticated: true
  });

  const cookies = setCookieHeaders(accepted);
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.match(cookies[0], /Path=\//);
  assert.match(cookies[0], /Max-Age=604800/);
  assert.doesNotMatch(cookies[0], /Secure/);

  const cookie = sessionCookie(accepted);
  const status = await getStatus(cookie);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).source, null);

  const authStatus = await fetch(
    `http://127.0.0.1:${server.port}/api/auth/status`,
    { headers: { Cookie: cookie } }
  );
  assert.deepEqual(await authStatus.json(), {
    required: true,
    authenticated: true
  });

  const chat = await postJson(server, '/api/chat', {
    messages: [{ role: 'user', content: 'Hello' }]
  }, { Cookie: cookie });
  assert.equal(chat.status, 503);
});

test('logout clears the session cookie', async () => {
  const logout = await postJson(server, '/api/auth/logout', {});
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });

  const cleared = setCookieHeaders(logout);
  assert.equal(cleared.length, 1);
  assert.match(cleared[0], /Max-Age=0/);

  const status = await getStatus();
  assert.equal(status.status, 401);
});

test('auth is disabled when ACCESS_PASSWORD is empty', async () => {
  const publicServer = await startServer({ ACCESS_PASSWORD: '' });

  try {
    const response = await fetch(
      `http://127.0.0.1:${publicServer.port}/api/auth/status`
    );
    assert.deepEqual(await response.json(), {
      required: false,
      authenticated: true
    });

    const status = await fetch(
      `http://127.0.0.1:${publicServer.port}/api/status`
    );
    assert.equal(status.status, 200);
  } finally {
    await stopServer(publicServer);
  }
});

test('production sessions use Secure cookies', async () => {
  const secureServer = await startServer({
    ACCESS_PASSWORD: PASSWORD,
    NODE_ENV: 'production'
  });

  try {
    const response = await postJson(secureServer, '/api/auth/login', {
      password: PASSWORD
    });
    assert.equal(response.status, 200);
    assert.match(setCookieHeaders(response)[0], /Secure/);
  } finally {
    await stopServer(secureServer);
  }
});

test('login attempts are rate limited after five requests per minute', async () => {
  const limitedServer = await startServer({ ACCESS_PASSWORD: PASSWORD });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postJson(limitedServer, '/api/auth/login', {
        password: 'wrong-password'
      });
      assert.equal(response.status, 401);
    }

    const blocked = await postJson(limitedServer, '/api/auth/login', {
      password: PASSWORD
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('retry-after'), /^\d+$/);
  } finally {
    await stopServer(limitedServer);
  }
});
