'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  authIsRequired,
  evaluateStatus,
  finalizeStreamText,
  statusPresentation
} = require('../public/ui-helpers');

test('heartbeat status uses the Kaggle label', () => {
  const presentation = statusPresentation({
    online: true,
    model: 'llama-3.2-3b',
    source: 'heartbeat',
    lastSeen: '2026-01-01T12:00:00.000Z'
  });

  assert.equal(presentation.state, 'online');
  assert.equal(presentation.text, 'Kaggle connected \u00b7 llama-3.2-3b');
  assert.match(presentation.title, /^Last heartbeat: /);
});

test('manual and env status use the generic model label', () => {
  const manual = statusPresentation({
    online: true,
    model: 'manual-model',
    source: 'manual'
  });
  assert.equal(manual.text, 'Model connected \u00b7 manual-model');

  const env = statusPresentation({
    online: true,
    model: null,
    source: 'env'
  });
  assert.equal(env.text, 'Model connected');
});

test('unknown status sources never claim a Kaggle heartbeat', () => {
  const presentation = statusPresentation({
    online: true,
    model: null,
    source: null,
    lastSeen: null
  });

  assert.equal(presentation.text, 'Connected');
  assert.doesNotMatch(presentation.text, /Kaggle/);
});

test('offline and checking statuses are distinct', () => {
  assert.deepEqual(statusPresentation({ online: false, source: 'heartbeat' }), {
    state: 'offline',
    text: 'Offline',
    title: 'Kaggle notebook is offline'
  });

  assert.equal(
    statusPresentation({ online: null }).state,
    'checking'
  );
});

test('the UI needs two consecutive failures before showing offline', () => {
  const previous = {
    online: true,
    failures: 0,
    model: 'mock',
    lastSeen: '2026-01-01T12:00:00.000Z',
    source: 'heartbeat'
  };

  const firstFailure = evaluateStatus(previous, { ok: false });
  assert.equal(firstFailure.online, true);
  assert.equal(firstFailure.failures, 1);

  const secondFailure = evaluateStatus(firstFailure, { ok: false });
  assert.equal(secondFailure.online, false);
  assert.equal(secondFailure.failures, 2);

  const recovered = evaluateStatus(secondFailure, {
    ok: true,
    data: { online: true, model: 'mock', lastSeen: null, source: 'manual' }
  });
  assert.equal(recovered.online, true);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.source, 'manual');
});

test('a stopped partial stream keeps a persisted stop note', () => {
  assert.equal(
    finalizeStreamText('Partial answer', true),
    'Partial answer\n\n*Stopped.*'
  );
  assert.equal(finalizeStreamText('Partial answer', false), 'Partial answer');
  assert.equal(finalizeStreamText('', true), '');
});

test('auth prompts only when required and unauthenticated', () => {
  assert.equal(authIsRequired({ required: true, authenticated: false }), true);
  assert.equal(authIsRequired({ required: true, authenticated: true }), false);
  assert.equal(authIsRequired({ required: false, authenticated: false }), false);
});
