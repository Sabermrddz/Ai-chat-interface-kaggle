'use strict';

const http = require('node:http');

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function writeSse(res, events, delayMs = 0) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();

  let index = 0;
  const sendNext = () => {
    if (index >= events.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify(events[index])}\n\n`);
    index += 1;
    setTimeout(sendNext, delayMs);
  };

  sendNext();
}

function startMockUpstream(initialOptions = {}) {
  const state = {
    model: 'mock-model',
    modelsStatus: 200,
    modelsBody: null,
    chatStatus: 200,
    chatBody: null,
    chatHandler: null,
    sseEvents: [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' from mock' } }] }
    ],
    sseDelayMs: 0,
    ...initialOptions
  };

  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;

    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      rawBody
    };
    requests.push(request);

    if (req.method === 'GET' && req.url === '/v1/models') {
      if (state.modelsBody !== null) {
        return writeJson(res, state.modelsStatus, state.modelsBody);
      }

      return writeJson(res, state.modelsStatus, {
        object: 'list',
        data: state.model ? [{ id: state.model, object: 'model' }] : []
      });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (state.chatHandler) {
        return state.chatHandler(req, res, { body, requests, state });
      }

      if (state.chatBody !== null) {
        return writeJson(res, state.chatStatus, state.chatBody);
      }

      if (body?.stream === false) {
        return writeJson(res, state.chatStatus, {
          id: 'mock-completion',
          model: body.model || state.model || 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from mock' },
              finish_reason: 'stop'
            }
          ]
        });
      }

      return writeSse(res, state.sseEvents, state.sseDelayMs);
    }

    return writeJson(res, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        state,
        close: () =>
          new Promise((closeResolve) => {
            server.closeAllConnections?.();
            server.close(() => closeResolve());
          })
      });
    });
  });
}

module.exports = { startMockUpstream };
