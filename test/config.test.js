'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

function read(fileName) {
  return fs.readFileSync(path.join(ROOT, fileName), 'utf8');
}

test('the server binds to HOST and defaults to all interfaces', () => {
  const source = read('server.js');
  assert.match(source, /const HOST = process\.env\.HOST \|\| '0\.0\.0\.0'/);
  assert.match(source, /app\.listen\(PORT, HOST/);
});

test('the environment template documents the new configuration', () => {
  const env = read('.env.example');
  assert.match(env, /^HOST=0\.0\.0\.0$/m);
  assert.match(env, /ACCESS_PASSWORD=/);
  assert.match(env, /REQUEST_BODY_LIMIT=/);
  assert.match(env, /BRIDGE_EXTRA_HOSTS=/);
});

test('the README documents notebook.ipynb and local-only binding', () => {
  const readme = read('README.md');
  assert.match(readme, /kaggle\/notebook\.ipynb/);
  assert.match(readme, /npm run build:notebook/);
  assert.match(readme, /HOST=127\.0\.0\.1/);
  assert.match(readme, /REQUEST_BODY_LIMIT/);
  assert.match(readme, /BRIDGE_EXTRA_HOSTS/);
  assert.match(readme, /ACCESS_PASSWORD/);
});

test('detaching a stream finalizes it instead of dropping it', () => {
  const source = read('public/app.js');
  const start = source.indexOf('function detachActiveStream()');
  const end = source.indexOf('function startNewChat()', start);
  const detach = source.slice(start, end);

  assert.ok(start !== -1);
  assert.match(detach, /finalizeStream\(streamState, true/);
});
