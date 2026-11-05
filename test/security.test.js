'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const {
  startServer,
  stopServer,
  postJson
} = require('./helpers/app-server');

const ALLOWED_ORIGIN = 'https://allowed.example';
let server;

before(async () => {
  server = await startServer({
    ALLOWED_ORIGIN,
    REQUEST_BODY_LIMIT: '1kb'
  });
});

after(async () => {
  await stopServer(server);
});

test('missing static extensions return 404 while SPA routes use index.html', async () => {
  const missing = await fetch(
    `http://127.0.0.1:${server.port}/missing-asset.js`
  );
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /text\/plain/);

  const spaRoute = await fetch(
    `http://127.0.0.1:${server.port}/some/client/route`
  );
  assert.equal(spaRoute.status, 200);
  assert.match(spaRoute.headers.get('content-type'), /text\/html/);
  assert.match(await spaRoute.text(), /<div class="app-shell">/);
});

test('CORS allows configured origins and rejects unknown origins', async () => {
  const allowed = await fetch(`http://127.0.0.1:${server.port}/health`, {
    headers: { Origin: ALLOWED_ORIGIN }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(allowed.headers.get('vary'), 'Origin');

  const blocked = await fetch(`http://127.0.0.1:${server.port}/health`, {
    headers: { Origin: 'https://blocked.example' }
  });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /origin is not allowed/i);
});

test('oversized JSON bodies are rejected', async () => {
  const response = await postJson(server, '/api/chat', {
    messages: [{ role: 'user', content: 'x'.repeat(2_000) }]
  });

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/i);
});

test('malformed JSON is rejected', async () => {
  const response = await postJson(server, '/api/chat', '{"messages":[');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /invalid JSON body/i);
});

test('bridge registration is disabled without BRIDGE_TOKEN', async () => {
  const noSecretServer = await startServer({ BRIDGE_TOKEN: '' });

  try {
    const response = await postJson(noSecretServer, '/api/bridge/register', {
      url: 'https://test.trycloudflare.com',
      model: 'test-model',
      token: 'anything'
    });

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /BRIDGE_TOKEN is not set/i);
  } finally {
    await stopServer(noSecretServer);
  }
});
