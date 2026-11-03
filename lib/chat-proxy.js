'use strict';

const {
  getUpstreamConfig,
  isBridgeUsable,
  resolveModelName
} = require('./bridge');

const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 16_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_SYSTEM_PROMPT_CHARS = 8_000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_OUTPUT_TOKENS = 4096;

function readPositiveInt(raw, fallback, min = 1_000, max = 600_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const CONNECT_TIMEOUT_MS = readPositiveInt(
  process.env.UPSTREAM_CONNECT_TIMEOUT_MS,
  30_000,
  1_000,
  120_000
);
const IDLE_TIMEOUT_MS = readPositiveInt(
  process.env.UPSTREAM_IDLE_TIMEOUT_MS,
  120_000,
  1_000,
  600_000
);

class ChatValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatValidationError';
    this.statusCode = 400;
  }
}

function readTemperature(value) {
  if (value === undefined || value === null) {
    return DEFAULT_TEMPERATURE;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChatValidationError('temperature must be a number between 0 and 2.');
  }
  return Math.min(2, Math.max(0, value));
}

function readMaxTokens(value) {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_TOKENS;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChatValidationError('max_tokens must be a number.');
  }
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(value)));
}

function validateMessages(rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ChatValidationError('Please type a message before sending.');
  }

  if (rawMessages.length > MAX_MESSAGES) {
    throw new ChatValidationError(`A conversation can contain at most ${MAX_MESSAGES} messages.`);
  }

  let totalCharacters = 0;
  const messages = rawMessages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ChatValidationError('Each message must be an object.');
    }

    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new ChatValidationError('Message roles must be system, user, or assistant.');
    }

    if (typeof message.content !== 'string') {
      throw new ChatValidationError('Each message needs string content.');
    }

    const content = message.content.trim();
    if (!content) {
      throw new ChatValidationError('Messages cannot be empty.');
    }

    if (content.length > MAX_CONTENT_CHARS) {
      throw new ChatValidationError(
        `Each message must be ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters or fewer.`
      );
    }

    totalCharacters += content.length;
    return { role, content };
  });

  if (!messages.some((message) => message.role === 'user')) {
    throw new ChatValidationError('A conversation must include a user message.');
  }

  if (totalCharacters > MAX_TOTAL_CHARS) {
    throw new ChatValidationError('The conversation is too long. Start a new chat or remove messages.');
  }

  return messages;
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ChatValidationError('Please type a message before sending.');
  }

  let messages;

  if (Array.isArray(body.messages)) {
    messages = validateMessages(body.messages);
  } else if (typeof body.message === 'string') {
    const content = body.message.trim();
    if (!content) {
      throw new ChatValidationError('Please type a message before sending.');
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ChatValidationError(
        `Each message must be ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters or fewer.`
      );
    }
    messages = [{ role: 'user', content }];
  } else {
    throw new ChatValidationError('Please type a message before sending.');
  }

  const systemPrompt =
    typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';

  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new ChatValidationError(
      `The system prompt must be ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString('en-US')} characters or fewer.`
    );
  }

  if (systemPrompt && !messages.some((message) => message.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  if (messages.length > MAX_MESSAGES) {
    throw new ChatValidationError(`A conversation can contain at most ${MAX_MESSAGES} messages.`);
  }

  const totalCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalCharacters > MAX_TOTAL_CHARS) {
    throw new ChatValidationError('The conversation is too long. Start a new chat or remove messages.');
  }

  return {
    messages,
    temperature: readTemperature(body.temperature),
    maxTokens: readMaxTokens(body.max_tokens ?? body.maxTokens),
    stream: body.stream !== false
  };
}

function sendJsonError(res, statusCode, message) {
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json({ error: message });
}

function startSse(res) {
  if (res.headersSent) {
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function writeSseData(res, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseError(res, message) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  writeSseData(res, { error: { message } });
  if (!res.writableEnded && !res.destroyed) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function logUpstreamFailure(message, error) {
  const name = error && error.name ? error.name : 'Error';
  const code = error && error.code ? ` (${error.code})` : '';
  console.error(`${message}: ${name}${code}`);
}

function extractReplyText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text;
  return typeof content === 'string' ? content : '';
}

async function proxyStreamingResponse(upstream, res, controller, outerCloseHandler) {
  const contentType = upstream.headers.get('content-type') || '';
  let clientClosed = false;

  const handleClientClose = () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort(new Error('client-closed'));
    }
  };

  res.on('close', handleClientClose);

  const responseIsClosed = () =>
    clientClosed || res.destroyed || res.writableEnded;

  try {
    if (!contentType.includes('text/event-stream')) {
      const bodyTimer = setTimeout(
        () => controller.abort(new Error('upstream-idle-timeout')),
        IDLE_TIMEOUT_MS
      );

      try {
        const data = await upstream.json();
        const reply = extractReplyText(data);

        if (responseIsClosed()) {
          return;
        }

        if (!reply.trim()) {
          startSse(res);
          writeSseError(res, 'The Kaggle notebook returned an empty response.');
          return;
        }

        startSse(res);
        writeSseData(res, { choices: [{ delta: { content: reply } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        clearTimeout(bodyTimer);
      }
      return;
    }

    if (!upstream.body) {
      startSse(res);
      writeSseError(res, 'The Kaggle notebook returned an empty response.');
      return;
    }

    startSse(res);

    let idleTimer = setTimeout(
      () => controller.abort(new Error('upstream-idle-timeout')),
      IDLE_TIMEOUT_MS
    );

    try {
      for await (const chunk of upstream.body) {
        if (responseIsClosed()) {
          break;
        }

        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => controller.abort(new Error('upstream-idle-timeout')),
          IDLE_TIMEOUT_MS
        );

        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            function finishWaiting() {
              res.off('drain', finishWaiting);
              res.off('close', finishWaiting);
              resolve();
            }
            res.once('drain', finishWaiting);
            res.once('close', finishWaiting);
          });
        }
      }

      if (!responseIsClosed()) {
        res.end();
      }
    } catch (error) {
      if (responseIsClosed()) {
        return;
      }

      const reason = controller.signal.reason?.message || '';
      logUpstreamFailure('Chat stream failed', error);
      writeSseError(
        res,
        reason === 'upstream-idle-timeout'
          ? 'The Kaggle notebook stopped responding. Please try again.'
          : 'The connection to the Kaggle notebook was interrupted.'
      );
    } finally {
      clearTimeout(idleTimer);
    }
  } catch (error) {
    if (responseIsClosed()) {
      return;
    }
    const reason = controller.signal.reason?.message || '';
    logUpstreamFailure('Chat response could not be read', error);
    startSse(res);
    writeSseError(
      res,
      reason === 'upstream-idle-timeout'
        ? 'The Kaggle notebook stopped responding. Please try again.'
        : 'The Kaggle notebook returned an invalid response.'
    );
  } finally {
    res.off('close', handleClientClose);
    if (outerCloseHandler) {
      res.off('close', outerCloseHandler);
    }
  }
}

async function chatHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let chatRequest;

  try {
    chatRequest = validateChatRequest(req.body);
  } catch (error) {
    if (error instanceof ChatValidationError) {
      return sendJsonError(res, 400, error.message);
    }
    console.error('Chat validation failed unexpectedly.');
    return sendJsonError(res, 400, 'Please check your message and try again.');
  }

  const config = getUpstreamConfig();

  if (!config || !isBridgeUsable()) {
    return sendJsonError(
      res,
      503,
      'Kaggle notebook is offline. Start the notebook and wait for it to connect.'
    );
  }

  let model;
  try {
    model = await resolveModelName();
  } catch {
    model = config.modelName || 'default';
  }

  if (res.destroyed) {
    return;
  }

  const controller = new AbortController();
  let clientClosed = false;

  const onClientClose = () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort(new Error('client-closed'));
    }
  };
  res.on('close', onClientClose);

  const connectTimer = setTimeout(
    () => controller.abort(new Error('upstream-connect-timeout')),
    CONNECT_TIMEOUT_MS
  );

  let upstream;

  try {
    upstream = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: chatRequest.stream ? 'text/event-stream' : 'application/json',
        ...(config.modelToken
          ? { Authorization: `Bearer ${config.modelToken}` }
          : {})
      },
      body: JSON.stringify({
        model,
        messages: chatRequest.messages,
        temperature: chatRequest.temperature,
        max_tokens: chatRequest.maxTokens,
        stream: chatRequest.stream
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(connectTimer);
    res.off('close', onClientClose);

    if (clientClosed) {
      return;
    }

    logUpstreamFailure('Chat upstream connection failed', error);
    const reason = controller.signal.reason?.message || '';
    const timedOut = reason === 'upstream-connect-timeout';

    return sendJsonError(
      res,
      timedOut ? 504 : 502,
      timedOut
        ? 'The Kaggle notebook took too long to respond. Please try again.'
        : 'Could not reach the Kaggle notebook. Check that the tunnel is running.'
    );
  }

  clearTimeout(connectTimer);

  if (!upstream.ok) {
    res.off('close', onClientClose);
    try {
      await upstream.body?.cancel();
    } catch {}

    console.error(`Chat upstream returned HTTP ${upstream.status}.`);

    if (upstream.status === 401 || upstream.status === 403) {
      return sendJsonError(
        res,
        502,
        'The Kaggle notebook rejected the request. Check that BRIDGE_TOKEN and KAGGLE_BRIDGE_TOKEN match.'
      );
    }

    if (upstream.status === 429) {
      return sendJsonError(
        res,
        503,
        'The Kaggle notebook is busy. Please try again in a moment.'
      );
    }

    if (upstream.status === 404) {
      return sendJsonError(
        res,
        502,
        'The Kaggle notebook has no chat endpoint. Check that the OpenAI-compatible server is running.'
      );
    }

    return sendJsonError(
      res,
      502,
      'The Kaggle notebook returned an error. Please try again.'
    );
  }

  if (!chatRequest.stream) {
    const bodyTimer = setTimeout(
      () => controller.abort(new Error('upstream-idle-timeout')),
      IDLE_TIMEOUT_MS
    );

    try {
      const data = await upstream.json();
      const reply = extractReplyText(data);

      if (!reply.trim()) {
        return sendJsonError(res, 502, 'The Kaggle notebook returned an empty response.');
      }

      return res.json({ reply, model: data.model || model });
    } catch (error) {
      if (clientClosed) {
        return;
      }
      const reason = controller.signal.reason?.message || '';
      const timedOut = reason === 'upstream-idle-timeout';
      logUpstreamFailure('Chat response could not be read', error);
      return sendJsonError(
        res,
        timedOut ? 504 : 502,
        timedOut
          ? 'The Kaggle notebook took too long to respond. Please try again.'
          : 'The Kaggle notebook returned an invalid response.'
      );
    } finally {
      clearTimeout(bodyTimer);
      res.off('close', onClientClose);
    }
  }

  return proxyStreamingResponse(upstream, res, controller, onClientClose);
}

module.exports = { chatHandler, validateChatRequest };
