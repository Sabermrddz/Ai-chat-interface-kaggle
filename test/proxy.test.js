'use strict';

const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { after, before, test } = require('node:test');

const {
  configureManualBridge,
  postJson,
  startServer,
  stopServer
} = require('./helpers/app-server');
const { startMockUpstream } = require('./helpers/mock-upstream');

let server;
let mock;

function chatRequest(body = {}, headers = {}) {
  return postJson(
    server,
    '/api/chat',
    {
      messages: [{ role: 'user', content: 'Hello' }],
      ...body
    },
    headers
  );
}

function chatCompletionRequest() {
  return mock.requests
    .filter((request) => request.url === '/v1/chat/completions')
    .at(-1);
}

const DEFAULT_SSE_EVENTS = [
  { choices: [{ delta: { content: 'Hello' } }] },
  { choices: [{ delta: { content: ' from mock' } }] }
];

function setNonStreamReply(content) {
  mock.state.chatHandler = null;
  mock.state.chatStatus = 200;
  mock.state.chatBody = {
    id: 'mock-completion',
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  };
}

function setStreamReply(contents, delayMs = 0) {
  mock.state.chatHandler = null;
  mock.state.chatStatus = 200;
  mock.state.chatBody = null;
  mock.state.sseDelayMs = delayMs;
  mock.state.sseEvents = contents.map((content) => ({
    choices: [{ delta: { content } }]
  }));
}

function resetChatMock() {
  mock.state.chatHandler = null;
  mock.state.chatStatus = 200;
  mock.state.chatBody = null;
  mock.state.sseDelayMs = 0;
  mock.state.sseEvents = DEFAULT_SSE_EVENTS;
}

before(async () => {
  mock = await startMockUpstream();
  server = await startServer({ SSE_KEEPALIVE_MS: '100' });

  const registration = await configureManualBridge(server, {
    url: mock.url,
    model: 'mock-model'
  });
  assert.equal(registration.status, 200);
});

after(async () => {
  await Promise.all([stopServer(server), mock.close()]);
});

test('non-streaming chat returns the upstream reply', async () => {
  const response = await chatRequest({ stream: false });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), {
    reply: 'Hello from mock',
    model: 'mock-model'
  });

  const upstreamRequest = chatCompletionRequest();
  assert.equal(upstreamRequest.body.stream, false);
  assert.equal(upstreamRequest.body.model, 'mock-model');
  assert.equal(upstreamRequest.body.max_tokens, 2048);
});

test('non-streaming replies strip reasoning after a missing opening tag', async (t) => {
  t.after(resetChatMock);
  setNonStreamReply('private chain</think>Final answer');

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'Final answer');
});

test('non-streaming replies strip complete think blocks', async (t) => {
  t.after(resetChatMock);
  setNonStreamReply('<think>private chain</think>Final answer');

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'Final answer');
});

test('non-streaming replies keep content without think tags', async (t) => {
  t.after(resetChatMock);
  setNonStreamReply('Plain answer');

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'Plain answer');
});

test('non-streaming reasoning-only replies return the budget error', async (t) => {
  t.after(resetChatMock);
  setNonStreamReply('private chain</think>');

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'The model used its whole token budget on reasoning; raise max_tokens.'
  });
});

test('unknown model names are omitted from the upstream request', async () => {
  mock.state.model = '';
  mock.state.modelsBody = { object: 'list', data: [] };

  const registration = await configureManualBridge(server, {
    url: mock.url,
    model: ''
  });
  assert.equal(registration.status, 200);

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 200);

  const upstreamRequest = chatCompletionRequest();
  assert.equal(Object.hasOwn(upstreamRequest.body, 'model'), false);
});

test('a literal "default" model name is omitted from the upstream request', async () => {
  mock.state.modelsBody = { object: 'list', data: [{ id: 'default' }] };

  const registration = await configureManualBridge(server, {
    url: mock.url,
    model: 'default'
  });
  assert.equal(registration.status, 200);
  assert.deepEqual(await registration.json(), { ok: true, model: null });

  const response = await chatRequest({ stream: false });
  assert.equal(response.status, 200);

  const upstreamRequest = chatCompletionRequest();
  assert.equal(Object.hasOwn(upstreamRequest.body, 'model'), false);

  mock.state.modelsBody = null;
  await configureManualBridge(server, {
    url: mock.url,
    model: 'mock-model'
  });
});

test('the string "false" disables streaming', async () => {
  mock.state.model = 'mock-model';
  mock.state.modelsBody = null;

  const registration = await configureManualBridge(server, {
    url: mock.url,
    model: 'mock-model'
  });
  assert.equal(registration.status, 200);

  const response = await chatRequest({ stream: 'false' });
  assert.equal(response.status, 200);
  assert.equal(chatCompletionRequest().body.stream, false);
  assert.match((await response.json()).reply, /Hello from mock/);
});

test('other non-boolean stream values are rejected', async () => {
  const response = await chatRequest({ stream: 'true' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /stream must be a boolean/i);
});

test('streaming chat forwards SSE data and the done marker', async () => {
  const response = await chatRequest({ stream: true });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const text = await response.text();
  assert.match(text, /Hello/);
  assert.match(text, /from mock/);
  assert.match(text, /\[DONE\]/);
  assert.equal(chatCompletionRequest().body.stream, true);
});

test('streaming strips reasoning when </think> is split across chunks', async (t) => {
  t.after(resetChatMock);
  setStreamReply(['private chain</thi', 'nk>Final answer']);

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.doesNotMatch(text, /private chain/);
  assert.match(text, /Final answer/);
  assert.match(text, /\[DONE\]/);
});

test('streaming strips complete think blocks', async (t) => {
  t.after(resetChatMock);
  setStreamReply(['<think>private chain</think>Final ', 'answer']);

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.doesNotMatch(text, /private chain/);
  assert.match(text, /Final/);
  assert.match(text, /answer/);
  assert.match(text, /\[DONE\]/);
});

test('streaming flushes buffered text when no think tags arrive', async (t) => {
  t.after(resetChatMock);
  setStreamReply(['Plain ', 'answer']);

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.match(text, /Plain/);
  assert.match(text, /answer/);
  assert.match(text, /\[DONE\]/);
});

test('streaming reasoning-only replies return the budget error', async (t) => {
  t.after(resetChatMock);
  setStreamReply(['private chain</think>']);

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.match(
    text,
    /The model used its whole token budget on reasoning; raise max_tokens\./
  );
  assert.match(text, /\[DONE\]/);
});

test('streaming sends SSE keep-alive comments while waiting for output', async () => {
  mock.state.chatHandler = (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders?.();

    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"Late"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 300);
  };

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.match(text, /: ping/);
  assert.match(text, /Late/);
  assert.match(text, /\[DONE\]/);

  mock.state.chatHandler = null;
});

test('upstream status codes map to friendly errors', async () => {
  mock.state.chatBody = { error: 'upstream failure' };

  mock.state.chatStatus = 401;
  let response = await chatRequest({ stream: false });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /rejected the request/i);

  mock.state.chatStatus = 404;
  response = await chatRequest({ stream: false });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /no chat endpoint/i);

  mock.state.chatStatus = 429;
  response = await chatRequest({ stream: false });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /busy/i);

  mock.state.chatStatus = 200;
  mock.state.chatBody = null;
});

test('an idle upstream stream is aborted with a friendly error', async () => {
  mock.state.chatHandler = (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders?.();
    res.write('data: {"choices":[{"delta":{"content":"Start"}}]}\n\n');
  };

  const response = await chatRequest({ stream: true });
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.match(text, /Start/);
  assert.match(text, /stopped responding/i);

  mock.state.chatHandler = null;
});

test('a client abort does not crash the proxy', async () => {
  mock.state.sseEvents = Array.from({ length: 20 }, (_, index) => ({
    choices: [{ delta: { content: `chunk-${index}` } }]
  }));
  mock.state.sseDelayMs = 40;

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true
    }),
    signal: controller.signal
  });

  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();

  await wait(250);

  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200);

  mock.state.sseDelayMs = 0;
  mock.state.sseEvents = [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' from mock' } }] }
  ];
});
