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

- Status badge with heartbeat/manual/env labels and a two-poll offline threshold
- Optional `ACCESS_PASSWORD` login with signed HttpOnly session cookies
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
server.js                    Express app, routes, middleware, startup/shutdown
lib/auth.js                  Optional password login, HMAC session cookies
lib/bridge.js                Bridge registration, heartbeat state, status ping
lib/chat-proxy.js            Validation and SSE proxy to the Kaggle model server
lib/rate-limit.js            Small in-memory rate limiter
kaggle/notebook.py           Kaggle notebook source (source of truth)
kaggle/notebook.ipynb        Generated Kaggle notebook (upload this file)
scripts/build-notebook.js    Generates notebook.ipynb from notebook.py
public/index.html            Chat UI
public/styles.css            UI styles and themes
public/ui-helpers.js         Status/auth presentation helpers
public/app.js                Chat behavior, streaming, markdown, storage
test/app.test.js             API status and chat error-path tests
test/auth.test.js            Password auth, cookies, and login rate limiting
test/config.test.js          HOST, docs, and detach-finalize wiring
test/proxy.test.js           Mock upstream, streaming, timeouts, and aborts
test/security.test.js        CORS, body limits, static 404s, registration
test/status.test.js          Env/manual status sources
test/frontend.test.js        Status labels, failure threshold, stop notes
test/notebook.test.js        Notebook generation and freshness checks
.env.example                 Environment variable template
Procfile                     Process command for Render/Railway/Heroku
```

## Requirements

- Node.js 22.x (declared in `package.json`; Heroku installs this automatically)
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
rejected and the UI stays offline. The default `HOST=0.0.0.0` accepts network
connections; set `HOST=127.0.0.1` for a local-only server.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_TOKEN` | none | Shared secret for notebook heartbeats; required for registration |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only access |
| `ALLOWED_ORIGIN` | same host | Comma-separated browser origins allowed to call the API |
| `ACCESS_PASSWORD` | none | Enables the password login for `/api/status` and `/api/chat` |
| `SESSION_SECRET` | derived | Optional independent HMAC key for session cookies; falls back to `ACCESS_PASSWORD` + `BRIDGE_TOKEN` |
| `NODE_ENV` | none | Set to `production` so session cookies are marked `Secure` |
| `REQUEST_BODY_LIMIT` | `256kb` | Maximum JSON request body size |
| `BRIDGE_EXTRA_HOSTS` | none | Extra heartbeat hostnames beyond `*.trycloudflare.com` |
| `SSE_KEEPALIVE_MS` | `15000` | Interval for SSE `: ping` comments while waiting for model output |
| `MODEL_API_URL` | none | Manual fallback model base URL (no `/v1` path) |
| `MODEL_NAME` | auto | Fallback model name for manual/env mode |
| `MODEL_API_KEY` | `BRIDGE_TOKEN` | Bearer token for the manual/env model server |
| `ADMIN_TOKEN` | `BRIDGE_TOKEN` | Token for `POST /api/bridge/manual` |
| `TRUST_PROXY` | none | Set to `1` behind a reverse proxy so rate limits see client IPs |

Timeout overrides are listed in `.env.example`.

## Run the model on Kaggle

1. Open `kaggle/notebook.ipynb` in Kaggle with **File > Import Notebook** (or
   upload it directly). If you change `kaggle/notebook.py`, regenerate it with
   `npm run build:notebook` before uploading. The `.py` file is the source of
   truth; do not upload it as the notebook.

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
- The status response includes `source`: `heartbeat`, `manual`, `env`, or `null`.
  The UI says **Kaggle connected** only for heartbeat mode, **Model connected**
  for manual/env mode, and waits for two consecutive failed polls before showing
  **Offline**.
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
heartbeat window, and `/api/status` reports `source: "env"`. The admin endpoint
below reports `source: "manual"`.

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
   - `ACCESS_PASSWORD` = optional long password for the login screen
5. Deploy, then set `SITE_URL` in the Kaggle notebook to the Render URL.

Render's free instance sleeps after inactivity. In-memory bridge state is lost
while asleep, but the notebook keeps sending heartbeats and re-registers after
the site wakes. For always-on use, choose a paid instance.

### Railway

Create a project from the same repo, use the `master` branch, start with
`npm start`, and set the same environment variables. Railway supports long-lived
HTTP streaming, which this app uses for SSE.

### Deploy to Heroku

Heroku no longer has a free tier: the **Eco dyno is paid**. This app is designed
to run on exactly one Eco web dyno. Do not scale to multiple dynos: bridge state,
rate-limit counters, and login sessions are in memory and are not shared between
processes. The app does not write to disk, so an ephemeral filesystem is fine;
restarts simply clear in-memory state.

Run these commands from the repository root (the branch is `master`):

```bash
heroku create
heroku config:set BRIDGE_TOKEN=your-long-random-secret
heroku config:set ALLOWED_ORIGIN=https://your-app.herokuapp.com
heroku config:set TRUST_PROXY=1
heroku config:set ACCESS_PASSWORD=your-long-random-password
heroku config:set NODE_ENV=production
heroku ps:scale web=1
git push heroku master
heroku logs --tail
```

Replace `your-app` in `ALLOWED_ORIGIN` with the app name printed by
`heroku create`. `BRIDGE_TOKEN` must be exactly the same value as the Kaggle
secret `KAGGLE_BRIDGE_TOKEN`, or heartbeats and upstream chat requests will be
rejected. Setting `SESSION_SECRET` is optional; if omitted, the session key is
derived from `ACCESS_PASSWORD` + `BRIDGE_TOKEN`.

Heroku's router closes requests that do not send a first byte within 30 seconds
(H12). Use a small, fast model (the default 3B GGUF), keep `max_tokens` at 2048
or higher for thinking models, and wait for the model to warm up. The server
sends an SSE `: ping` comment every 15 seconds while a stream is buffering
reasoning or waiting for its first token, which keeps the connection active.

The Kaggle heartbeat runs every 30 seconds and also keeps the Eco dyno awake;
without traffic, Eco dynos sleep. In-memory state is lost after a sleep or
restart, but the next heartbeat restores the tunnel URL automatically.

Do not use `git push heroku main`; this repository's branch is `master`.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Basic health check (always public) |
| `GET` | `/api/auth/status` | `{ required, authenticated }` for the login UI |
| `POST` | `/api/auth/login` | Password login; rate limited to 5 attempts/minute/IP |
| `POST` | `/api/auth/logout` | Clears the session cookie |
| `GET` | `/api/status` | `{ online, model, lastSeen, source }` |
| `POST` | `/api/chat` | Validate and proxy a chat request; streams SSE |
| `POST` | `/api/bridge/register` | Notebook heartbeat; requires `BRIDGE_TOKEN` |
| `POST` | `/api/bridge/manual` | Admin-only manual tunnel setup |

When `ACCESS_PASSWORD` is set, `/api/status`, `/api/chat`, and the chat UI require
a signed session cookie from `/api/auth/login`. Bridge registration still uses
`BRIDGE_TOKEN`. The session cookie is `HttpOnly`, `SameSite=Strict`, valid for
seven days, and marked `Secure` in production or over HTTPS.

`POST /api/chat` accepts:

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": true
}
```

The legacy `{ "message": "Hello" }` shape is still accepted. The server caps
message count, per-message length, total conversation length, and output tokens.
Set `stream` to a boolean; the string `"false"` is also accepted for compatibility,
and other non-boolean values return HTTP 400. If no model name can be resolved,
the upstream request omits the `model` field instead of sending `"default"`.

The server strips Qwen-style reasoning tags from replies. Non-streaming replies
keep only the text after the last `</think>`, and streaming replies buffer until
`</think>` appears before forwarding the final answer. Streams without closing
tags are flushed when they end. If stripping leaves no answer, the API returns
`The model used its whole token budget on reasoning; raise max_tokens.`

## Security notes

- Keep `.env` out of git; it is already in `.gitignore`.
- Use a long random `BRIDGE_TOKEN` and the same value for the Kaggle secret.
  Rotate both if the value is ever exposed.
- Set a long random `ACCESS_PASSWORD` for a public deployment. Login is rate
  limited, and the HMAC-signed session cookie cannot be read by JavaScript.
  Optionally set `SESSION_SECRET` so rotating `ACCESS_PASSWORD` or `BRIDGE_TOKEN`
  does not invalidate existing sessions; without it, the key is derived from both.
- The quick tunnel URL is public, but the model server requires the bearer token.
  The browser never receives the token.
- The Express server logs only method, path, status, and duration. It does not log
  request bodies, headers, tokens, or passwords.
- CORS is restricted to `ALLOWED_ORIGIN` in production. Set it to the exact
  origin, without a trailing slash.
- Rate limits, a 256 KB JSON body limit, input validation, CSP, and basic security
  headers are enabled by default. The server writes no application data to disk.
- Keep `HOST=127.0.0.1` when you do not want the server reachable outside the
  local machine.
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

### The badge says "Model connected" instead of "Kaggle connected"

That is expected for `MODEL_API_URL` (env) or `POST /api/bridge/manual` (manual)
mode. **Kaggle connected** is used only for notebook heartbeats.

### The login screen keeps appearing or APIs return 401

Check that `ACCESS_PASSWORD` is set consistently for the server and that cookies
are enabled in the browser. Behind HTTPS, set `NODE_ENV=production` (or trust the
proxy) so the session cookie is marked `Secure`. If you changed the password,
existing cookies become invalid and you need to sign in again.

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

The tests use Node's built-in test runner and spawn the server on local ports. A
mock OpenAI-compatible upstream covers streaming, non-streaming, timeouts, client
aborts, and upstream error mapping. The suite also covers auth cookies and login
rate limiting, CORS, body limits, static 404s, status sources, and notebook
generation freshness. No real tunnel, GPU, or model is required.
