'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const {
  configureManualBridge,
  startServer,
  stopServer
} = require('./helpers/app-server');
const { startMockUpstream } = require('./helpers/mock-upstream');

let mock;
let envServer;
let manualServer;

before(async () => {
  mock = await startMockUpstream({ model: 'mock-model' });

  envServer = await startServer({
    MODEL_API_URL: mock.url,
    MODEL_NAME: 'env-model'
  });
  manualServer = await startServer();

  const registration = await configureManualBridge(manualServer, {
    url: mock.url,
    model: 'manual-model'
  });
  assert.equal(registration.status, 200);
});

after(async () => {
  await Promise.all([
    stopServer(envServer),
    stopServer(manualServer),
    mock.close()
  ]);
});

test('status reports env mode as a model connection', async () => {
  const response = await fetch(
    `http://127.0.0.1:${envServer.port}/api/status`
  );

  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.online, true);
  assert.equal(status.model, 'env-model');
  assert.equal(status.source, 'env');
  assert.equal(status.lastSeen, null);
});

test('status reports manual mode as a model connection', async () => {
  const response = await fetch(
    `http://127.0.0.1:${manualServer.port}/api/status`
  );

  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.online, true);
  assert.equal(status.model, 'manual-model');
  assert.equal(status.source, 'manual');
  assert.equal(typeof status.lastSeen, 'string');
});
