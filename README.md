# AI Chat Website

This project is a beginner-friendly AI chat website built with Node.js, Express, and plain HTML, CSS, and JavaScript. It is ready to deploy to Heroku.

## Features

- Responsive chat layout that works on desktop and mobile
- User and AI message styling
- Enter to send, Shift+Enter for a new line
- Typing animation while waiting for the AI
- Welcome screen before the first message
- New Chat button to reset the conversation
- Friendly error handling for AI service issues
- Accessible form labels and keyboard-friendly controls

## Project structure

- `server.js` – Express server and AI endpoint
- `public/index.html` – the HTML page for the app
- `public/styles.css` – layout and visual styling
- `public/app.js` – client-side chat behavior
- `.env.example` – example environment variable setup
- `Procfile` – Heroku startup command

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set the model service URL in your environment.

   On macOS or Linux:

   ```bash
   export MODEL_API_URL=https://your-model-service.example.com/api/chat
   ```

   On Windows PowerShell:

   ```powershell
   $env:MODEL_API_URL = "https://your-model-service.example.com/api/chat"
   ```

3. Start the app:

   ```bash
   npm start
   ```

   Or use the development script:

   ```bash
   npm run dev
   ```

4. Open this URL in your browser:

   ```text
   http://localhost:3000
   ```

## Heroku deployment

1. Install the Heroku CLI and log in:

   ```bash
   heroku login
   ```

2. Create a Heroku app:

   ```bash
   heroku create
   ```

3. Set the model service URL as a config variable:

   ```bash
   heroku config:set MODEL_API_URL=https://your-model-service.example.com/api/chat
   ```

4. Deploy the app:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git push heroku main
   ```

5. Open the deployed app:

   ```bash
   heroku open
   ```

## Important note about the model integration

This app is ready to call a backend AI service through `MODEL_API_URL`, but the repo URL you mentioned is not a direct API endpoint:

```text
https://huggingface.co/AtomicChat/DeepSeek-V4.1-Flash-1017-Uncensored-GSQ-RCO-GGUF/tree/main
```

That URL points to the model card/repository page, not a live inference API. To make the chat work with Hugging Face, you need either:

- a Hugging Face Inference Endpoint, or
- a local/custom proxy server that calls the model, or
- another backend service that exposes a JSON API.

The browser still calls the app's local `/api/chat` endpoint, and the server then calls your configured model service behind the scenes.

Do not put API keys or secrets in browser code. Keep them in environment variables on the server only.

## Where to connect your model later

Open `server.js` and look for the `callModelService` function. This is the exact place to replace the placeholder logic with your real AI model request.

The app reads the model URL from the `MODEL_API_URL` environment variable, which Heroku can set using `heroku config:set`.

Example:

```bash
heroku config:set MODEL_API_URL=https://your-inference-endpoint.example.com/api
```
