'use strict';

const STORAGE_KEYS = {
  conversations: 'aiChat.conversations.v1',
  activeId: 'aiChat.activeId.v1',
  settings: 'aiChat.settings.v1',
  theme: 'aiChat.theme.v1'
};

const MAX_SAVED_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const CONTEXT_MESSAGE_LIMIT = 40;
const MAX_HISTORY_CHARS = 16_000;
const STATUS_POLL_MS = 10_000;

const DEFAULT_SETTINGS = Object.freeze({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  maxTokens: 2048
});

const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const stopButton = document.getElementById('stop-button');
const messagesContainer = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const welcomeScreen = document.getElementById('welcome-screen');
const newChatButton = document.getElementById('new-chat');
const errorBanner = document.getElementById('error-banner');
const offlineNotice = document.getElementById('offline-notice');
const promptButtons = document.querySelectorAll('.prompt-button');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const themeToggle = document.getElementById('theme-toggle');
const settingsButton = document.getElementById('settings-button');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingsClose = document.getElementById('settings-close');
const settingsReset = document.getElementById('settings-reset');
const systemPromptInput = document.getElementById('system-prompt');
const temperatureInput = document.getElementById('temperature');
const temperatureValue = document.getElementById('temperature-value');
const maxTokensInput = document.getElementById('max-tokens');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarClose = document.getElementById('sidebar-close');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const conversationList = document.getElementById('conversation-list');
const emptyConversations = document.getElementById('empty-conversations');
const authDialog = document.getElementById('auth-dialog');
const authForm = document.getElementById('auth-form');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authLogout = document.getElementById('auth-logout');

const ui = window.ChatUI;

const state = {
  conversations: loadConversations(),
  activeId: '',
  draft: null,
  settings: loadSettings(),
  theme: loadTheme(),
  online: null,
  statusModel: null,
  statusLastSeen: null,
  statusSource: null,
  statusFailures: 0,
  statusInFlight: false,
  authRequired: false,
  authAuthenticated: true,
  waiting: false,
  abortController: null,
  stream: null
};

state.activeId = loadActiveId(state.conversations);

function readStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function readJsonStorage(key, fallback) {
  const raw = readStorage(key, '');
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraft() {
  const now = Date.now();
  return {
    id: createId(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }
  if (typeof message.content !== 'string' || !message.content.trim()) {
    return null;
  }
  return { role: message.role, content: message.content };
}

function loadConversations() {
  const stored = readJsonStorage(STORAGE_KEYS.conversations, []);
  if (!Array.isArray(stored)) {
    return [];
  }

  return stored
    .filter((conversation) => conversation && typeof conversation === 'object')
    .map((conversation) => {
      const messages = Array.isArray(conversation.messages)
        ? conversation.messages
            .map(normalizeMessage)
            .filter(Boolean)
            .slice(-MAX_MESSAGES_PER_CONVERSATION)
        : [];

      if (messages.length === 0) {
        return null;
      }

      const firstUserMessage = messages.find((message) => message.role === 'user');
      const createdAt = Number(conversation.createdAt) || Date.now();
      const updatedAt = Number(conversation.updatedAt) || createdAt;

      return {
        id:
          typeof conversation.id === 'string' && conversation.id
            ? conversation.id
            : createId(),
        title:
          typeof conversation.title === 'string' && conversation.title.trim()
            ? conversation.title.trim().slice(0, 80)
            : makeTitle(firstUserMessage?.content || ''),
        createdAt,
        updatedAt,
        messages
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

function loadActiveId(conversations) {
  const stored = readStorage(STORAGE_KEYS.activeId, '');
  if (typeof stored !== 'string' || !stored) {
    return '';
  }
  return conversations.some((conversation) => conversation.id === stored) ? stored : '';
}

function loadSettings() {
  const stored = readJsonStorage(STORAGE_KEYS.settings, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...DEFAULT_SETTINGS };
  }

  const systemPrompt =
    typeof stored.systemPrompt === 'string'
      ? stored.systemPrompt.slice(0, 8000)
      : DEFAULT_SETTINGS.systemPrompt;
  const temperature =
    typeof stored.temperature === 'number' && Number.isFinite(stored.temperature)
      ? Math.min(2, Math.max(0, stored.temperature))
      : DEFAULT_SETTINGS.temperature;
  const maxTokens =
    typeof stored.maxTokens === 'number' && Number.isFinite(stored.maxTokens)
      ? Math.min(4096, Math.max(1, Math.floor(stored.maxTokens)))
      : DEFAULT_SETTINGS.maxTokens;

  return { systemPrompt, temperature, maxTokens };
}

function loadTheme() {
  const stored = readStorage(STORAGE_KEYS.theme, '');
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

function makeTitle(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'New chat';
  }
  return cleaned.length > 46 ? `${cleaned.slice(0, 46).trimEnd()}...` : cleaned;
}

function getActiveConversation() {
  if (state.activeId) {
    const existing = state.conversations.find(
      (conversation) => conversation.id === state.activeId
    );
    if (existing) {
      return existing;
    }
    state.activeId = '';
  }

  if (!state.draft) {
    state.draft = createDraft();
  }

  return state.draft;
}

function saveConversations() {
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);

  if (state.conversations.length > MAX_SAVED_CONVERSATIONS) {
    state.conversations.length = MAX_SAVED_CONVERSATIONS;
  }

  for (const conversation of state.conversations) {
    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conversation.messages.splice(
        0,
        conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION
      );
    }
  }

  if (
    state.activeId &&
    !state.conversations.some((conversation) => conversation.id === state.activeId)
  ) {
    state.activeId = '';
    state.draft = createDraft();
  }

  let serialized = JSON.stringify(state.conversations);
  let saved = writeStorage(STORAGE_KEYS.conversations, serialized);

  if (!saved) {
    state.conversations.length = Math.min(10, state.conversations.length);
    for (const conversation of state.conversations) {
      conversation.messages.splice(0, Math.max(0, conversation.messages.length - 50));
    }
    serialized = JSON.stringify(state.conversations);
    saved = writeStorage(STORAGE_KEYS.conversations, serialized);
  }

  writeStorage(STORAGE_KEYS.activeId, state.activeId || '');
  return saved;
}

function promoteConversation(conversation, firstUserText) {
  const exists = state.conversations.some(
    (savedConversation) => savedConversation.id === conversation.id
  );

  if (!exists) {
    conversation.title = makeTitle(firstUserText);
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
    state.draft = null;
    writeStorage(STORAGE_KEYS.activeId, state.activeId);
    return;
  }

  if (conversation.title === 'New chat') {
    conversation.title = makeTitle(firstUserText);
  }
}

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE_MAP[character]);
}

function sanitizeUrl(raw) {
  try {
    const decoded = String(raw).replace(/&amp;/g, '&');
    const parsed = new URL(decoded);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function renderInline(text) {
  let html = escapeHtml(text);
  const codeSpans = [];

  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const index = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000CODE${index}\u0000`;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
      return label;
    }
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (match, index) => {
    return codeSpans[Number(index)] || '';
  });

  return html;
}

function renderCodeBlock(code, language) {
  const lang = String(language || '')
    .trim()
    .slice(0, 30)
    .replace(/[^\w.+#-]/g, '');
  const label = lang || 'code';

  return [
    '<div class="code-block">',
    '<div class="code-header">',
    `<span class="code-lang">${escapeHtml(label)}</span>`,
    '<button type="button" class="copy-code-button" data-copy-code aria-label="Copy code">Copy</button>',
    '</div>',
    `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code)}</code></pre>`,
    '</div>'
  ].join('');
}

function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let listType = '';
  let listItems = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType) {
      return;
    }
    output.push(
      `<${listType}>${listItems
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join('')}</${listType}>`
    );
    listType = '';
    listItems = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+.#-]*)\s*$/);

    if (fence) {
      flushParagraph();
      flushList();

      const language = fence[1] || '';
      const codeLines = [];
      index += 1;

      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      output.push(renderCodeBlock(codeLines.join('\n'), language));
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push('<hr>');
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();

      const quoteLines = [quote[1]];
      while (index + 1 < lines.length && /^\s*>\s?/.test(lines[index + 1])) {
        index += 1;
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
      }

      output.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType && listType !== nextType) {
        flushList();
      }
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return output.join('\n');
}

function createMessageElement(role, content) {
  const article = document.createElement('article');
  article.className = `message ${role === 'user' ? 'user' : 'ai'}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = renderMarkdown(content);

  article.appendChild(bubble);
  return { article, bubble };
}

function appendMessageElement(role, content) {
  const element = createMessageElement(role, content);
  messagesContainer.appendChild(element.article);
  scrollMessagesToBottom();
  return element;
}

function scrollMessagesToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function setTypingIndicator(isVisible) {
  typingIndicator.classList.toggle('hidden', !isVisible);
  if (isVisible) {
    scrollMessagesToBottom();
  }
}

function showWelcomeScreen(show) {
  welcomeScreen.classList.toggle('hidden', !show);
}

function updateWelcomeState() {
  const conversation = getActiveConversation();
  showWelcomeScreen(conversation.messages.length === 0 && !state.waiting);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function clearError() {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

function updateAuthVisibility() {
  const signedIn = state.authRequired && state.authAuthenticated;
  authLogout.classList.toggle('hidden', !signedIn);
}

function showAuthDialog() {
  updateAuthVisibility();

  if (typeof authDialog.showModal === 'function') {
    if (!authDialog.open) {
      authDialog.showModal();
    }
  } else {
    authDialog.setAttribute('open', '');
  }

  window.setTimeout(() => authPassword.focus(), 0);
}

function closeAuthDialog() {
  if (typeof authDialog.close === 'function' && authDialog.open) {
    authDialog.close();
  } else {
    authDialog.removeAttribute('open');
  }
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.remove('hidden');
}

async function checkAuthStatus() {
  try {
    const response = await fetch('/api/auth/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    state.authRequired = Boolean(data.required);
    state.authAuthenticated = !state.authRequired || Boolean(data.authenticated);
    updateAuthVisibility();
    updateComposerState();

    if (state.authRequired && !state.authAuthenticated) {
      showAuthDialog();
    } else {
      closeAuthDialog();
    }
  } catch {
    updateAuthVisibility();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  authError.classList.add('hidden');
  authSubmit.disabled = true;

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: authPassword.value })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Could not unlock the chat.');
    }

    state.authRequired = Boolean(data.required);
    state.authAuthenticated = !state.authRequired || Boolean(data.authenticated);
    updateAuthVisibility();
    closeAuthDialog();
    authPassword.value = '';
    clearError();
    await refreshStatus();
  } catch (error) {
    showAuthError(error.message || 'Could not unlock the chat.');
    authPassword.focus();
  } finally {
    authSubmit.disabled = false;
  }
}

async function logout() {
  authLogout.disabled = true;

  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error('Could not sign out.');
    }

    state.authAuthenticated = false;
    state.online = null;
    state.statusFailures = 0;
    state.statusModel = null;
    state.statusLastSeen = null;
    state.statusSource = null;
    detachActiveStream();
    updateStatusBadge();

    if (state.authRequired) {
      showAuthDialog();
    } else {
      closeAuthDialog();
      updateAuthVisibility();
    }
  } catch (error) {
    showError(error.message || 'Could not sign out.');
  } finally {
    authLogout.disabled = false;
  }
}

function sizeTextArea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function updateStatusBadge() {
  const presentation = ui.statusPresentation({
    online: state.online,
    model: state.statusModel,
    lastSeen: state.statusLastSeen,
    source: state.statusSource
  });

  statusBadge.dataset.state = presentation.state;
  statusText.textContent = presentation.text;
  statusBadge.title = presentation.title;

  updateComposerState();
}

function updateComposerState() {
  const isOffline = state.online === false;
  const needsAuth = state.authRequired && !state.authAuthenticated;

  messageInput.disabled = isOffline || needsAuth;
  sendButton.disabled = isOffline || needsAuth || state.waiting;
  stopButton.classList.toggle('hidden', !state.waiting);
  stopButton.disabled = !state.waiting;
  messageInput.placeholder = needsAuth
    ? 'Enter the access password to chat.'
    : isOffline
      ? 'The model is offline - start it to chat.'
      : 'Type your message...';
  offlineNotice.classList.toggle('hidden', !isOffline);
  messagesContainer.setAttribute('aria-busy', state.waiting ? 'true' : 'false');
}

function applyStatusResult(result) {
  const next = ui.evaluateStatus(
    {
      online: state.online,
      failures: state.statusFailures,
      model: state.statusModel,
      lastSeen: state.statusLastSeen,
      source: state.statusSource
    },
    result
  );

  state.online = next.online;
  state.statusFailures = next.failures;
  state.statusModel = next.model;
  state.statusLastSeen = next.lastSeen;
  state.statusSource = next.source;
}

function markUnauthorized() {
  state.authRequired = true;
  state.authAuthenticated = false;
  state.online = null;
  state.statusFailures = 0;
  state.statusModel = null;
  state.statusLastSeen = null;
  state.statusSource = null;
  updateAuthVisibility();
  showAuthDialog();
  updateComposerState();
}

async function refreshStatus() {
  if (state.statusInFlight) {
    return;
  }

  state.statusInFlight = true;

  try {
    const response = await fetch('/api/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    if (response.status === 401) {
      markUnauthorized();
      return;
    }

    if (!response.ok) {
      throw new Error('Status request failed.');
    }

    applyStatusResult({ ok: true, data: await response.json() });
  } catch {
    applyStatusResult({ ok: false });
  } finally {
    state.statusInFlight = false;
    updateStatusBadge();
  }
}

function renderSidebar() {
  conversationList.innerHTML = '';

  const conversations = state.conversations
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);

  emptyConversations.classList.toggle('hidden', conversations.length > 0);

  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.id = conversation.id;

    if (conversation.id === state.activeId) {
      item.classList.add('active');
    }

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'conversation-select';
    selectButton.dataset.action = 'select';
    selectButton.title = conversation.title;
    if (conversation.id === state.activeId) {
      selectButton.setAttribute('aria-current', 'true');
    }

    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conversation.title;

    const meta = document.createElement('span');
    meta.className = 'conversation-meta';
    meta.textContent = `${conversation.messages.length} message${
      conversation.messages.length === 1 ? '' : 's'
    }`;

    selectButton.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'conversation-actions';

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'conversation-action';
    renameButton.dataset.action = 'rename';
    renameButton.textContent = '\u270e';
    renameButton.title = 'Rename chat';
    renameButton.setAttribute('aria-label', `Rename ${conversation.title}`);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'conversation-action delete';
    deleteButton.dataset.action = 'delete';
    deleteButton.textContent = '\u00d7';
    deleteButton.title = 'Delete chat';
    deleteButton.setAttribute('aria-label', `Delete ${conversation.title}`);

    actions.append(renameButton, deleteButton);
    item.append(selectButton, actions);
    conversationList.appendChild(item);
  }
}

function renderActiveConversation() {
  const conversation = getActiveConversation();
  const fragment = document.createDocumentFragment();

  for (const message of conversation.messages) {
    fragment.appendChild(createMessageElement(message.role, message.content).article);
  }

  messagesContainer.innerHTML = '';
  messagesContainer.appendChild(fragment);
  setTypingIndicator(false);
  updateWelcomeState();
  scrollMessagesToBottom();
}

function buildRequestMessages(conversation) {
  const systemPrompt = state.settings.systemPrompt.trim();
  const limit = systemPrompt ? CONTEXT_MESSAGE_LIMIT - 1 : CONTEXT_MESSAGE_LIMIT;
  const selected = [];
  let totalChars = systemPrompt.length;

  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= limit) {
      break;
    }

    const message = conversation.messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    if (selected.length > 0 && totalChars + message.content.length > MAX_HISTORY_CHARS) {
      break;
    }

    selected.unshift({ role: message.role, content: message.content });
    totalChars += message.content.length;
  }

  if (systemPrompt) {
    selected.unshift({ role: 'system', content: systemPrompt });
  }

  return selected;
}

function extractSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  const boundary = /\r?\n\r?\n/;
  let match = boundary.exec(rest);

  while (match) {
    events.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
    match = boundary.exec(rest);
  }

  return { events, rest };
}

function handleSseEvent(rawEvent, streamState) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));

  if (dataLines.length === 0) {
    return;
  }

  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  if (parsed?.error) {
    const message =
      typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
    throw new Error(message || 'The Kaggle notebook returned an error.');
  }

  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const delta = choice?.delta?.content ?? choice?.text ?? '';

  if (typeof delta === 'string' && delta) {
    appendStreamText(streamState, delta);
  }
}

async function readSseStream(response, streamState) {
  if (!response.body) {
    throw new Error('The Kaggle notebook returned an empty response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.rest;

      for (const event of parsed.events) {
        handleSseEvent(event, streamState);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleSseEvent(buffer, streamState);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
  }
}

function scheduleStreamRender(streamState) {
  if (streamState.raf) {
    return;
  }

  streamState.raf = window.requestAnimationFrame(() => {
    streamState.raf = 0;
    if (streamState.bubble) {
      streamState.bubble.innerHTML = renderMarkdown(streamState.text);
      scrollMessagesToBottom();
    }
  });
}

function appendStreamText(streamState, delta) {
  if (!state.stream || state.stream !== streamState) {
    return;
  }

  if (!streamState.message) {
    streamState.message = { role: 'assistant', content: '' };
    streamState.conversation.messages.push(streamState.message);
    streamState.bubble = appendMessageElement('ai', '').bubble;
    setTypingIndicator(false);
  }

  streamState.text += delta;
  streamState.message.content = streamState.text;
  scheduleStreamRender(streamState);
}

function finalizeStream(streamState, aborted, errorMessage) {
  if (streamState.finalized) {
    return;
  }
  streamState.finalized = true;

  if (streamState.raf) {
    window.cancelAnimationFrame(streamState.raf);
    streamState.raf = 0;
  }

  streamState.text = ui.finalizeStreamText(streamState.text, aborted);

  if (streamState.bubble) {
    streamState.bubble.innerHTML = renderMarkdown(streamState.text);
  }

  if (!streamState.text && !errorMessage) {
    errorMessage = aborted ? '' : 'The Kaggle notebook returned an empty response.';
  }

  if (streamState.message) {
    streamState.message.content = streamState.text;

    if (!streamState.text) {
      const index = streamState.conversation.messages.indexOf(streamState.message);
      if (index !== -1) {
        streamState.conversation.messages.splice(index, 1);
      }
    } else {
      streamState.conversation.updatedAt = Date.now();
    }
  }

  saveConversations();

  if (state.stream === streamState) {
    state.stream = null;
    state.abortController = null;
    state.waiting = false;
    setTypingIndicator(false);
    updateComposerState();
    updateWelcomeState();

    if (errorMessage) {
      showError(errorMessage);
      if (!streamState.bubble) {
        appendMessageElement('ai', errorMessage);
      }
    }

    messageInput.focus();
  }

  renderSidebar();
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();

  if (!text || state.waiting) {
    return;
  }

  if (state.online === false) {
    showError('Kaggle notebook is offline. Start the notebook and wait for it to reconnect.');
    return;
  }

  clearError();

  const conversation = getActiveConversation();
  conversation.messages.push({ role: 'user', content: text });
  conversation.updatedAt = Date.now();
  promoteConversation(conversation, text);

  appendMessageElement('user', text);
  updateWelcomeState();
  saveConversations();
  renderSidebar();

  state.waiting = true;
  updateComposerState();
  setTypingIndicator(true);

  const controller = new AbortController();
  const streamState = {
    conversation,
    text: '',
    message: null,
    bubble: null,
    raf: 0
  };

  state.abortController = controller;
  state.stream = streamState;

  let aborted = false;
  let errorMessage = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        messages: buildRequestMessages(conversation),
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens,
        stream: true
      }),
      signal: controller.signal
    });

    if (response.status === 401) {
      markUnauthorized();
      throw new Error('Enter the access password to continue.');
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The AI service is currently unavailable.');
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      await readSseStream(response, streamState);
    } else {
      const data = await response.json().catch(() => ({}));
      if (typeof data.reply === 'string' && data.reply.trim()) {
        appendStreamText(streamState, data.reply);
      } else {
        throw new Error('The Kaggle notebook returned an unexpected response.');
      }
    }
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      aborted = true;
    } else {
      errorMessage =
        error.message || 'The AI service is currently unavailable. Please try again.';
    }
  }

  finalizeStream(streamState, aborted, errorMessage);
}

function detachActiveStream() {
  const controller = state.abortController;
  const streamState = state.stream;

  if (controller) {
    controller.abort();
  }

  if (streamState) {
    finalizeStream(streamState, true, '');
  } else {
    state.waiting = false;
    setTypingIndicator(false);
    updateComposerState();
  }
}

function startNewChat() {
  detachActiveStream();

  state.activeId = '';
  state.draft = createDraft();
  writeStorage(STORAGE_KEYS.activeId, '');
  clearError();
  messageInput.value = '';
  sizeTextArea();
  renderActiveConversation();
  renderSidebar();
  updateComposerState();
  closeSidebar();
  messageInput.focus();
}

function selectConversation(conversationId) {
  if (state.activeId === conversationId) {
    closeSidebar();
    messageInput.focus();
    return;
  }

  const conversation = state.conversations.find(
    (item) => item.id === conversationId
  );

  if (!conversation) {
    return;
  }

  detachActiveStream();
  state.activeId = conversationId;
  state.draft = null;
  writeStorage(STORAGE_KEYS.activeId, conversationId);
  clearError();
  renderActiveConversation();
  renderSidebar();
  closeSidebar();
  messageInput.focus();
}

function renameConversation(conversation) {
  const nextTitle = window.prompt('Rename chat', conversation.title);
  if (nextTitle === null) {
    return;
  }

  const title = nextTitle.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) {
    return;
  }

  conversation.title = title;
  conversation.updatedAt = Date.now();
  saveConversations();
  renderSidebar();
}

function deleteConversation(conversation) {
  const shouldDelete = window.confirm(
    `Delete "${conversation.title}"? This cannot be undone.`
  );

  if (!shouldDelete) {
    return;
  }

  const index = state.conversations.findIndex((item) => item.id === conversation.id);
  if (index === -1) {
    return;
  }

  state.conversations.splice(index, 1);

  if (state.activeId === conversation.id) {
    detachActiveStream();
    state.activeId = '';
    state.draft = createDraft();
    writeStorage(STORAGE_KEYS.activeId, '');
    clearError();
    renderActiveConversation();
  }

  saveConversations();
  renderSidebar();
  messageInput.focus();
}

function openSettings() {
  systemPromptInput.value = state.settings.systemPrompt;
  temperatureInput.value = String(state.settings.temperature);
  temperatureValue.textContent = state.settings.temperature.toFixed(1);
  maxTokensInput.value = String(state.settings.maxTokens);

  if (typeof settingsDialog.showModal === 'function') {
    if (!settingsDialog.open) {
      settingsDialog.showModal();
    }
  } else {
    settingsDialog.setAttribute('open', '');
  }

  systemPromptInput.focus();
}

function closeSettings() {
  if (typeof settingsDialog.close === 'function' && settingsDialog.open) {
    settingsDialog.close();
  } else {
    settingsDialog.removeAttribute('open');
  }
}

function saveSettingsFromForm(event) {
  event.preventDefault();

  const systemPrompt = systemPromptInput.value.slice(0, 8000);
  const rawTemperature = Number(temperatureInput.value);
  const rawMaxTokens = Number(maxTokensInput.value);

  const temperature = Number.isFinite(rawTemperature)
    ? Math.min(2, Math.max(0, rawTemperature))
    : DEFAULT_SETTINGS.temperature;
  const maxTokens = Number.isFinite(rawMaxTokens)
    ? Math.min(4096, Math.max(1, Math.floor(rawMaxTokens)))
    : DEFAULT_SETTINGS.maxTokens;

  state.settings = { systemPrompt, temperature, maxTokens };
  writeStorage(STORAGE_KEYS.settings, JSON.stringify(state.settings));
  closeSettings();
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
  themeToggle.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  );

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', theme === 'dark' ? '#070b14' : '#eef2ff');
  }

  writeStorage(STORAGE_KEYS.theme, theme);
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.remove('hidden');
  sidebarToggle.setAttribute('aria-expanded', 'true');
  sidebarClose.focus();
}

function closeSidebar(options = {}) {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.add('hidden');
  sidebarToggle.setAttribute('aria-expanded', 'false');

  if (options.restoreFocus) {
    sidebarToggle.focus();
  }
}

function updateTemperatureOutput() {
  const value = Number(temperatureInput.value);
  temperatureValue.textContent = Number.isFinite(value) ? value.toFixed(1) : '0.7';
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }

  const helper = document.createElement('textarea');
  helper.className = 'clipboard-helper';
  helper.value = text;
  helper.setAttribute('readonly', '');
  document.body.appendChild(helper);
  helper.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    helper.remove();
  }

  if (!copied) {
    throw new Error('Copy failed.');
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (state.waiting) {
    return;
  }

  if (state.online === false) {
    showError('Kaggle notebook is offline. Start the notebook and wait for it to reconnect.');
    return;
  }

  const message = messageInput.value;
  if (!message.trim()) {
    return;
  }

  messageInput.value = '';
  sizeTextArea();
  sendMessage(message);
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.waiting) {
      chatForm.requestSubmit();
    }
  }
});

messageInput.addEventListener('input', () => {
  sizeTextArea();
});

newChatButton.addEventListener('click', () => {
  startNewChat();
});

promptButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (state.online === false) {
      showError('Kaggle notebook is offline. Start the notebook and wait for it to reconnect.');
      return;
    }
    messageInput.value = button.textContent.trim();
    sizeTextArea();
    messageInput.focus();
  });
});

stopButton.addEventListener('click', () => {
  if (state.abortController) {
    stopButton.disabled = true;
    state.abortController.abort();
  }
});

themeToggle.addEventListener('click', toggleTheme);
settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsForm.addEventListener('submit', saveSettingsFromForm);
temperatureInput.addEventListener('input', updateTemperatureOutput);
authForm.addEventListener('submit', submitAuth);
authLogout.addEventListener('click', logout);
authDialog.addEventListener('cancel', (event) => event.preventDefault());

settingsReset.addEventListener('click', () => {
  systemPromptInput.value = DEFAULT_SETTINGS.systemPrompt;
  temperatureInput.value = String(DEFAULT_SETTINGS.temperature);
  temperatureValue.textContent = DEFAULT_SETTINGS.temperature.toFixed(1);
  maxTokensInput.value = String(DEFAULT_SETTINGS.maxTokens);
});

settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) {
    closeSettings();
  }
});

sidebarToggle.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
sidebarBackdrop.addEventListener('click', () => closeSidebar({ restoreFocus: true }));

document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    sidebar.classList.contains('open') &&
    !settingsDialog.open
  ) {
    closeSidebar({ restoreFocus: true });
  }
});

conversationList.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) {
    return;
  }

  const item = actionButton.closest('.conversation-item');
  const conversation = state.conversations.find(
    (candidate) => candidate.id === item?.dataset.id
  );

  if (!conversation) {
    return;
  }

  if (actionButton.dataset.action === 'select') {
    selectConversation(conversation.id);
  } else if (actionButton.dataset.action === 'rename') {
    renameConversation(conversation);
  } else if (actionButton.dataset.action === 'delete') {
    deleteConversation(conversation);
  }
});

messagesContainer.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-code]');
  if (!copyButton) {
    return;
  }

  const codeElement = copyButton.closest('.code-block')?.querySelector('code');
  if (!codeElement) {
    return;
  }

  try {
    await copyText(codeElement.textContent || '');
    copyButton.textContent = 'Copied';
    copyButton.setAttribute('aria-label', 'Code copied');

    window.setTimeout(() => {
      copyButton.textContent = 'Copy';
      copyButton.setAttribute('aria-label', 'Copy code');
    }, 1600);
  } catch {
    showError('Could not copy the code block.');
  }
});

if (typeof window.matchMedia === 'function') {
  const mobileQuery = window.matchMedia('(max-width: 900px)');
  const handleMobileChange = (event) => {
    if (!event.matches) {
      closeSidebar();
    }
  };

  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', handleMobileChange);
  } else if (typeof mobileQuery.addListener === 'function') {
    mobileQuery.addListener(handleMobileChange);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshStatus();
  }
});

window.addEventListener('online', refreshStatus);

applyTheme(state.theme);
renderSidebar();
renderActiveConversation();
updateAuthVisibility();
updateStatusBadge();
sizeTextArea();

async function initialize() {
  await checkAuthStatus();
  await refreshStatus();
  window.setInterval(refreshStatus, STATUS_POLL_MS);
}

initialize();
