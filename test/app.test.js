const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

const pkg = require('../package.json');

assert.equal(pkg.scripts.dev, 'node server.js');

(async () => {
  const port = 3457;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdio: 'inherit'
  });

  try {
    await wait(800);

    const response = await fetch(`http://localhost:${port}/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(body, { status: 'ok' });
    console.log('Health check passed.');
  } finally {
    child.kill('SIGTERM');
  }
})();
