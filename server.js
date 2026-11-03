const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL_API_URL = process.env.MODEL_API_URL || '';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function buildPlaceholderResponse(userMessage) {
  const cleanedMessage = userMessage.trim();
  const replies = [
    `Placeholder AI reply: I received your message, "${cleanedMessage}". This app is ready for your real model integration.`,
    `Placeholder AI reply: Thanks for the message, "${cleanedMessage}". Replace this placeholder in the server code with your actual AI model call.`,
    `Placeholder AI reply: You said, "${cleanedMessage}". This response is only a demo until you connect your model service.`,
    `Placeholder AI reply: The frontend is correctly talking to /api/chat. When you set MODEL_API_URL, you can swap this placeholder for your real model logic.`
  ];

  return replies[Math.floor(Math.random() * replies.length)];
}

async function callModelService(userMessage) {
  // This function is the exact place to connect your real AI model.
  // The app reads the URL from the MODEL_API_URL environment variable.
  // Keep any secrets on the server only, never in browser code.
  //
  // IMPORTANT: a Hugging Face repository page such as the "tree/main" URL is not
  // a direct inference API. Use a real JSON endpoint, such as a Hugging Face
  // Inference Endpoint, a custom FastAPI proxy, or a local model server.
  //
  // Example integration pattern:
  //
  // if (!MODEL_API_URL) {
  //   throw new Error('MODEL_API_URL is not configured.');
  // }
  //
  // const response = await fetch(MODEL_API_URL, {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     ...(process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {})
  //   },
  //   body: JSON.stringify({ inputs: userMessage })
  // });
  //
  // if (!response.ok) {
  //   throw new Error('The external AI service is unavailable.');
  // }
  //
  // const data = await response.json();
  // return data.reply || data.message || data.generated_text || data[0]?.generated_text || 'I could not generate a response.';

  if (!MODEL_API_URL) {
    return buildPlaceholderResponse(userMessage);
  }

  try {
    const response = await fetch(MODEL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: userMessage })
    });

    if (!response.ok) {
      throw new Error(`Model service returned ${response.status}`);
    }

    const data = await response.json();

    if (typeof data.reply === 'string' && data.reply.trim()) {
      return data.reply;
    }

    if (typeof data.message === 'string' && data.message.trim()) {
      return data.message;
    }

    if (typeof data.generated_text === 'string' && data.generated_text.trim()) {
      return data.generated_text;
    }

    if (Array.isArray(data) && typeof data[0]?.generated_text === 'string') {
      return data[0].generated_text;
    }

    return buildPlaceholderResponse(userMessage);
  } catch (error) {
    console.error('Model service request failed:', error);
    throw new Error('The AI service is temporarily unavailable. Please try again in a moment.');
  }
}

app.post('/api/chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();

  if (!message) {
    return res.status(400).json({
      error: 'Please type a message before sending.'
    });
  }

  try {
    const replyText = await callModelService(message);

    return res.json({
      reply: replyText
    });
  } catch (error) {
    console.error('AI request failed:', error);

    return res.status(503).json({
      error: 'The AI service is temporarily unavailable. Please try again in a moment.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the current server or start this app on a different port with PORT=3001 npm start.`);
    process.exit(1);
  }

  throw error;
});
