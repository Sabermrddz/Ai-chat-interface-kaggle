# Kaggle LLM Chat

A small AI chat website (Node.js + Express + plain HTML/CSS/JS) that talks to a
model running in a free Kaggle notebook. The notebook serves a GGUF model through
an OpenAI-compatible API, publishes it with a Cloudflare quick tunnel, and sends
heartbeats to this site. The browser only ever talks to the Express backend; the
tunnel URL and tokens never reach client code.

## Architecture

```text
Browser
  |  fetch /api/status, /api/chat (SSE)
  v
Express server (this repo)
  |  reads in-memory bridge state
  |  forwards /v1/chat/completions with Authorization: Bearer <token>
  v
Cloudflare quick tunnel  --->  Kaggle notebook
                                 llama-cpp-python server :8000
                                 GGUF weights from Hugging Face

Kaggle notebook  --POST /api/bridge/register every 30s-->  Express server
```

The Express server is the only component that knows the current tunnel URL. The
notebook re-registers whenever the quick tunnel URL changes.

## Features

- Status badge in the header: green "Kaggle connected + model" or red "Offline"
- Streaming tokens into the AI bubble, with a Stop button (AbortController)
- Settings panel for system prompt, temperature, and max tokens (localStorage)
- Conversation history in localStorage with a sidebar (rename, delete, New Chat)
- Safe markdown rendering and code blocks with copy buttons
- Enter to send, Shift+Enter for a new line, typing animation, welcome screen
- Dark/light theme, responsive mobile drawer, accessible labels and focus states
- Server-side rate limiting, CORS allow-list, request size limits, input
  validation, security headers, and no secret logging

## Project structure

```text
server.js               Express app, routes, middleware, startup/shutdown
lib/bridge.js           Bridge registration, heartbeat state, status ping
lib/chat-proxy.js       Validation and SSE proxy to the Kaggle model server
lib/rate-limit.js       Small in-memory rate limiter
kaggle/notebook.py      Kaggle notebook cells (copy into a Kaggle notebook)
public/index.html       Chat UI
public/styles.css       UI styles and themes
public/app.js           Chat behavior, streaming, markdown, storage
test/app.test.js        API status and chat error-path tests
.env.example            Environment variable template
Procfile                Process command for Render/Railway/Heroku
```

## Requirements

- Node.js 18 or newer
- A Kaggle account with Internet and GPU enabled
- A Cloudflare quick tunnel (the notebook downloads `cloudflared`)
- A long random shared secret, for example from `openssl rand -hex 32`

No additional npm packages are required beyond Express. The frontend uses plain
JavaScript and a small built-in safe markdown renderer.

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

   On Node.js 20.12+ the server loads `.env` automatically. On older Node
   versions, export the variables in your shell instead. PowerShell example:

   ```powershell
   $env:BRIDGE_TOKEN = "your-long-random-secret"
   $env:ALLOWED_ORIGIN = "http://localhost:3000"
   $env:PORT = "3000"
   ```

3. Start the site:

   ```bash
   npm start
   ```

4. Open `http://localhost:3000`.

5. Start the Kaggle notebook (below) with `SITE_URL` pointing at your site. For
   local testing, the notebook must be able to reach your machine, so use a
   deployed site or a public URL for `SITE_URL`.

`BRIDGE_TOKEN` is required. If it is missing, heartbeat registrations are
rejected and the UI stays offline.

## Run the model on Kaggle

1. Create a new Kaggle notebook and copy the cells from `kaggle/notebook.py` into
   it (or upload the file and open it as a notebook).

2. In the notebook settings:
   - Enable **Internet**.
   - Enable a **GPU** (T4 x2 or P100 is enough for the default 3B model).

3. Add secrets in **Add-ons > Secrets** and attach them to the notebook:
   - `KAGGLE_BRIDGE_TOKEN` (required): the same long random value as the
     website's `BRIDGE_TOKEN`.
   - `HF_TOKEN` (optional): only needed for gated Hugging Face repositories.

4. In the configuration cell, set:
   - `SITE_URL`: your deployed site URL, for example
     `https://my-chat.onrender.com` (no trailing slash).
   - `REPO_ID` and `FILENAME`: the GGUF model to download.
   - `MODEL_ALIAS`: the model name shown in the UI and sent to the API.
   - `N_GPU_LAYERS` and `N_CTX`: GPU layers and context size.

   The default is `bartowski/Llama-3.2-3B-Instruct-GGUF` with
   `Llama-3.2-3B-Instruct-Q4_K_M.gguf` and an 8192-token context. It fits a free
   Kaggle GPU. The browser keeps full history locally but sends only recent
   messages within a 16k-character budget so requests fit the notebook context.

5. Run all cells. The first run installs `llama-cpp-python`, downloads the model,
   starts the OpenAI-compatible server on port 8000, opens the tunnel, and begins
   heartbeats. Leave the final cell running.

6. The site should show **Kaggle connected** within about 30 seconds. If it does
   not, check the notebook's heartbeat logs and the troubleshooting section.

Kaggle sessions have time limits and can be stopped at any time. When the
notebook restarts, the quick tunnel URL changes; the heartbeat updates the site
automatically.

### About the model repository URL

A Hugging Face repository page such as
`https://huggingface.co/<user>/<repo>/tree/main` is a file browser, not an
inference API. This project does the correct thing instead:

1. `huggingface_hub.hf_hub_download()` downloads the GGUF weights from the repo.
2. `llama-cpp-python` serves those weights locally with an OpenAI-compatible
   `/v1/chat/completions` endpoint.
3. Cloudflare exposes that endpoint through a temporary HTTPS tunnel.

The `AtomicChat/DeepSeek-V4.1-Flash-1017-Uncensored-GSQ-RCO-GGUF` repository is
split into multi-part shards that total far more than a free Kaggle GPU can hold.
For a larger GPU, point `FILENAME` at the first shard and download all shards
with `snapshot_download(repo_id=..., allow_patterns=[...])`, then pass the first
shard path to the server.

## How the heartbeat works

- Every 30 seconds the notebook POSTs this JSON to `/api/bridge/register`:

  ```json
  { "url": "https://random-name.trycloudflare.com", "model": "llama-3.2-3b", "token": "shared-secret" }
  ```

- The Express server compares `token` with `BRIDGE_TOKEN` using a timing-safe
  comparison. It stores `{ tunnelUrl, modelName, lastSeen }` in memory and never
  returns the token to the browser.
- `/api/status` reports `online: true` only when both conditions hold:
  1. the last heartbeat was within 90 seconds, and
  2. a live `GET {tunnelUrl}/v1/models` ping succeeds.
- The tunnel URL changes every session. The next heartbeat replaces the old URL,
  so you normally do not need to edit anything.
- In-memory state is lost when the website restarts. The notebook's next
  heartbeat (within 30 seconds) restores it.
- The browser never sees the tunnel URL or any token. Only the Express server
  talks to Kaggle.

## Manual fallback (no heartbeat)

Use this when you want to point the site at a fixed model server without running
the heartbeat.

### Environment variables

```env
MODEL_API_URL=https://your-tunnel-or-model-server.example.com
MODEL_NAME=llama-3.2-3b
MODEL_API_KEY=optional-model-bearer-token
```

`MODEL_API_URL` must be the base URL (no `/v1` path). HTTPS is required except
for `localhost`. `MODEL_API_KEY` defaults to `BRIDGE_TOKEN` if unset. In manual
mode, online status depends on the live `/v1/models` ping, not the 90-second
heartbeat window.

### Admin endpoint

`POST /api/bridge/manual` is protected by `ADMIN_TOKEN` (or `BRIDGE_TOKEN` if
`ADMIN_TOKEN` is unset). Send the admin token as a bearer token:

```bash
curl -X POST https://your-site.example.com/api/bridge/manual \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-tunnel.example.com","model":"llama-3.2-3b","token":"optional-model-key"}'
```

A heartbeat registration will override a manual registration. Manual state is
also in memory and is lost on restart.

## Deployment

The default branch in this repository is `master`. Use `master` in the commands
below.

### Render (recommended free option)

1. Push the repo to GitHub.
2. In Render, create a **Web Service** from the repo.
3. Set:
   - Branch: `master`
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variables:
   - `BRIDGE_TOKEN` = your long random secret (same as the Kaggle secret)
   - `ALLOWED_ORIGIN` = `https://your-app.onrender.com`
   - `TRUST_PROXY` = `1`
5. Deploy, then set `SITE_URL` in the Kaggle notebook to the Render URL.

Render's free instance sleeps after inactivity. In-memory bridge state is lost
while asleep, but the notebook keeps sending heartbeats and re-registers after
the site wakes. For always-on use, choose a paid instance.

### Railway

Create a project from the same repo, use the `master` branch, start with
`npm start`, and set the same environment variables. Railway supports long-lived
HTTP streaming, which this app uses for SSE.

### Heroku

Heroku no longer has a free tier. The included `Procfile` still works on a paid
dyno:

```bash
heroku create
heroku config:set BRIDGE_TOKEN=your-long-random-secret
heroku config:set ALLOWED_ORIGIN=https://your-app.herokuapp.com
heroku config:set TRUST_PROXY=1
git push heroku master
```

Do not use `git push heroku main`; this repository's branch is `master`.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Basic health check |
| `GET` | `/api/status` | `{ online, model, lastSeen }` |
| `POST` | `/api/chat` | Validate and proxy a chat request; streams SSE |
| `POST` | `/api/bridge/register` | Notebook heartbeat; requires `BRIDGE_TOKEN` |
| `POST` | `/api/bridge/manual` | Admin-only manual tunnel setup |

`POST /api/chat` accepts:

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": true
}
```

The legacy `{ "message": "Hello" }` shape is still accepted. The server caps
message count, per-message length, total conversation length, and output tokens.

## Security notes

- Keep `.env` out of git; it is already in `.gitignore`.
- Use a long random `BRIDGE_TOKEN` and the same value for the Kaggle secret.
  Rotate both if the value is ever exposed.
- The quick tunnel URL is public, but the model server requires the bearer token.
  The browser never receives the token.
- The Express server logs only method, path, status, and duration. It does not log
  request bodies, headers, or tokens.
- CORS is restricted to `ALLOWED_ORIGIN` in production. Set it to the exact
  origin, without a trailing slash.
- Rate limits, a 256 KB JSON body limit, input validation, CSP, and basic security
  headers are enabled by default.
- Bridge state is in memory only. There is no database and no persistence of
  secrets.

## Troubleshooting

### The badge stays red / Offline

- Check that the final Kaggle cell is still running.
- Check the notebook heartbeat logs. A `401` means `KAGGLE_BRIDGE_TOKEN` and the
  website's `BRIDGE_TOKEN` do not match.
- A `503` from registration means the website has no `BRIDGE_TOKEN` set.
- The heartbeat must be received within the last 90 seconds.
- The live `/v1/models` ping must succeed. A running tunnel with a crashed model
  server still counts as offline.
- If you restarted the website, wait up to 30 seconds for the next heartbeat.

### 503 "Kaggle notebook is offline"

There is no fresh heartbeat. Start the notebook and wait for the final cell to
report a heartbeat, or use the manual fallback.

### 502 Bad gateway

The tunnel is reachable but the model server is not healthy. Check the
`llama_server.log` tail printed by the notebook, confirm port 8000 is listening,
and wait for the model to finish loading. A 401/403 from the model server usually
means the token does not match.

### 504 Gateway timeout

The model server did not respond before the connection timeout. It may still be
loading the model, or the GPU is overloaded. Try a smaller quant, a smaller
context, or fewer GPU layers.

### Streaming stops or arrives all at once

- Cloudflare quick tunnels and some reverse proxies buffer responses. This app
  sends `Cache-Control: no-transform` and `X-Accel-Buffering: no`, but a proxy can
  still interfere.
- The server aborts an idle upstream stream after 120 seconds by default. Adjust
  `UPSTREAM_IDLE_TIMEOUT_MS` if needed.
- Test the tunnel directly:

  ```bash
  curl -N https://your-tunnel.trycloudflare.com/v1/chat/completions \
    -H "Authorization: Bearer $KAGGLE_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"model":"llama-3.2-3b","messages":[{"role":"user","content":"Hi"}],"stream":true}'
  ```

### 429 Too many requests

The built-in limiter allows 120 API requests per minute and 20 chat requests per
minute per client IP. Wait for the `Retry-After` period.

### 403 This origin is not allowed

Set `ALLOWED_ORIGIN` to the exact browser origin, including `https://` and
without a trailing slash. Restart the site after changing it.

### The model download fails

- Gated models require accepting the license on Hugging Face and an `HF_TOKEN`
  Kaggle secret.
- Check the exact `FILENAME` in the repository's Files tab.
- Kaggle's disk is limited; choose a smaller quant if needed.

### GPU out of memory

Lower `N_CTX`, choose a smaller quantization (for example Q4_K_M instead of
Q6_K), or reduce `N_GPU_LAYERS` to offload fewer layers.

### Kaggle session stops

Kaggle notebooks are not permanent servers. Restart the notebook, and the next
heartbeat will update the tunnel URL automatically.

## Tests

```bash
npm test
```

The tests use Node's built-in test runner and spawn the server on local ports.
They cover `/api/status`, registration validation, manual auth, chat validation,
and the offline chat error path. No real tunnel or model is required.
