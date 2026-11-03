const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const messagesContainer = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const welcomeScreen = document.getElementById('welcome-screen');
const newChatButton = document.getElementById('new-chat');
const errorBanner = document.getElementById('error-banner');
const promptButtons = document.querySelectorAll('.prompt-button');

const state = {
  waitingForReply: false,
  messages: []
};

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setTypingIndicator(isVisible) {
  typingIndicator.classList.toggle('hidden', !isVisible);
  if (isVisible) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function showWelcomeScreen(show) {
  welcomeScreen.classList.toggle('hidden', !show);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function clearError() {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

function updateWelcomeState() {
  showWelcomeScreen(state.messages.length === 0 && !state.waitingForReply);
}

function addMessage(role, text) {
  const safeText = String(text || '').trim();

  if (!safeText) {
    return;
  }

  const article = document.createElement('article');
  article.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const paragraph = document.createElement('p');
  paragraph.innerHTML = escapeHtml(safeText);
  bubble.appendChild(paragraph);
  article.appendChild(bubble);
  messagesContainer.appendChild(article);

  state.messages.push({ role, text: safeText });
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  updateWelcomeState();
}

function clearChat() {
  state.messages = [];
  state.waitingForReply = false;
  messagesContainer.innerHTML = '';
  clearError();
  setTypingIndicator(false);
  updateWelcomeState();
  messageInput.value = '';
  messageInput.focus();
}

function sizeTextArea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

async function sendMessage(message) {
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    return;
  }

  clearError();
  state.waitingForReply = true;
  addMessage('user', trimmedMessage);
  setTypingIndicator(true);
  updateWelcomeState();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: trimmedMessage })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'The AI service is currently unavailable.');
    }

    addMessage('ai', data.reply || 'Sorry, I did not receive a reply.');
  } catch (error) {
    const friendlyMessage =
      error.message || 'The AI service is currently unavailable. Please try again.';

    addMessage('ai', friendlyMessage);
    showError(friendlyMessage);
  } finally {
    state.waitingForReply = false;
    setTypingIndicator(false);
    updateWelcomeState();
    messageInput.focus();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (state.waitingForReply) {
    return;
  }

  const message = messageInput.value;
  messageInput.value = '';
  sizeTextArea();
  sendMessage(message);
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

messageInput.addEventListener('input', () => {
  sizeTextArea();
});

newChatButton.addEventListener('click', () => {
  clearChat();
});

promptButtons.forEach((button) => {
  button.addEventListener('click', () => {
    messageInput.value = button.textContent.trim();
    sizeTextArea();
    messageInput.focus();
  });
});

sizeTextArea();
updateWelcomeState();
