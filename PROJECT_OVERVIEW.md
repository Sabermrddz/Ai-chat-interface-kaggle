# PROJECT OVERVIEW

**Scope of this review:** every project file was read or regenerated except `node_modules/` and `package-lock.json`, as requested. The repository is branch `master`: base commit `78f51d7` (`update`), feature commit `7890ac1` (`Add auth, status sources, and notebook generation`), pushed to `origin`. This revision was updated on 2026-11-05 after implementing authentication, status-source labels, stream/model fixes, notebook generation, Heroku readiness (Node 22, startup flags, SSE keep-alive, single-dyno deployment docs), and the expanded 56-test suite. No real secrets, tokens, or API keys are present; `.env.example` placeholders and test-only secrets are not production credentials.

---

## 1. PROJECT SUMMARY

What the app does today:

- It is a Node.js + Express web app that serves a static single-page chat UI from `public/` and exposes a small JSON/SSE API.
- A browser can hold multiple conversations, rename/delete them, save them in `localStorage`, and render assistant replies as limited Markdown with streaming and code-copy buttons.
- The server discovers an OpenAI-compatible model endpoint in three ways: a Kaggle-notebook heartbeat (`POST /api/bridge/register`), an admin manual registration (`POST /api/bridge/manual`), or optional environment settings (`MODEL_API_URL`, `MODEL_NAME`, `MODEL_API_KEY`).
- `GET /api/status` reports whether the endpoint is usable by checking heartbeat freshness (90 seconds) and, when configured, a live `GET {baseUrl}/v1/models` request. It now includes a `source` field: `heartbeat`, `manual`, `env`, or `null`.
- `POST /api/chat` validates the conversation and proxies it to `{baseUrl}/v1/chat/completions`, either forwarding upstream SSE or returning a JSON reply.
- Optional password protection is available through `ACCESS_PASSWORD`. When set, `/api/status` and `/api/chat` require an HMAC-signed session cookie issued by `/api/auth/login`; bridge heartbeat registration still uses `BRIDGE_TOKEN`.
- `kaggle/notebook.py` is the source of truth for the external notebook. `npm run build:notebook` generates `kaggle/notebook.ipynb` from its `# %%` cells, and the generated notebook is the file to upload to Kaggle.
- The notebook downloads a GGUF model from Hugging Face, starts `llama-cpp-python` with a bearer token, opens a Cloudflare quick tunnel, and heartbeats the tunnel URL to the website.
- By default no model endpoint is configured. The UI then shows Offline (after two failed polls) and chat requests return HTTP 503 once authenticated.
- Bridge state, rate-limit counters, and login rate limits are in memory only. There is no database, user account model, or persistent server-side conversation storage.
- No Kaggle notebook, tunnel, model weights, or deployed instance is running inside this workspace; the integration requires external setup.

**Intended goal:** a chat UI that connects to an LLM hosted in a Kaggle notebook (models from Hugging Face) and shows whether Kaggle is online. The repository implements the UI, proxy, heartbeat protocol, optional access password, and notebook glue for that goal, but it does not bundle a model or a hosted backend.

---

## 2. TECH STACK AND VERSIONS

| Item | Value |
| --- | --- |
| Runtime declared in `package.json` | Node.js `22.x` (`engines.node`) |
| Runtime used for the checks in this document | Node.js `v24.14.1`, npm `11.11.0` |
| Backend framework | Express, declared as `^4.19.2`; this workspace resolves `express@4.22.3` |
| Dependencies | `express` only |
| DevDependencies | none |
| Frontend | Plain HTML, CSS, and browser JavaScript; no framework, bundler, or CDN |
| Tests | Node.js built-in test runner (`node:test`), no test framework dependency |
| External Python runtime | Kaggle notebook uses Python, `huggingface_hub`, and `llama-cpp-python[server]` (installed at runtime, unpinned), plus the `cloudflared` Linux binary (downloaded at runtime, unpinned) |
| Persistence | Browser `localStorage` plus in-memory server state; no database |

**npm scripts** (exact):

```json
"start": "node server.js",
"dev": "node server.js",
"build:notebook": "node scripts/build-notebook.js",
"test": "node --test test/*.test.js"
```

`start` and `dev` are identical; there is no watcher/hot-reload process. `build:notebook` regenerates `kaggle/notebook.ipynb` from `kaggle/notebook.py`.

**Procfile** (exact, one line):

```text
web: node server.js
```

`package-lock.json` exists and pins the root engine to `22.x`. `Procfile` is the only deployment manifest; the README documents Heroku deployment (single Eco dyno). The app has no writable-disk dependency: all server state is in memory.

---

## 3. FILE TREE

`node_modules/` and `.git/` are omitted. This is the current working-tree layout, including new files added by the feature work.

```text
kaggle-interface/
├── .env.example                  Environment-variable template (HOST, auth, limits, timeouts)
├── .gitignore                    Ignores node_modules/, .env, npm-debug.log*, and .DS_Store
├── package.json                  Metadata, Node engine, dependency, and npm scripts
├── package-lock.json             npm lockfile (present; excluded from review)
├── Procfile                      Process declaration: `web: node server.js`
├── README.md                     Setup, architecture, auth, status, deployment, API, troubleshooting
├── PROJECT_OVERVIEW.md           Detailed project reference (this document)
├── server.js                     Express app: middleware, routes, auth, startup/shutdown, static files
├── kaggle/
│   ├── notebook.py               Source notebook cells: install, download GGUF, serve, tunnel, heartbeat
│   └── notebook.ipynb            Generated upload-ready notebook (18 cells: 10 markdown, 8 code)
├── lib/
│   ├── auth.js                   Optional ACCESS_PASSWORD login, HMAC session cookies, auth middleware
│   ├── bridge.js                 Bridge state, token checks, URL validation, status ping, admin auth
│   ├── chat-proxy.js             Chat validation, upstream request, SSE/JSON proxy, error mapping
│   └── rate-limit.js             Small in-memory fixed-window rate limiter
├── public/
│   ├── app.js                    Chat behavior: auth, status polling, streaming, storage, markdown, UI
│   ├── index.html                Page structure: sidebar, header/status, messages, auth/settings dialogs
│   ├── styles.css                Light/dark themes, layout, auth/settings dialogs, responsive rules
│   └── ui-helpers.js             Pure status/auth/stream presentation helpers (CommonJS + browser global)
├── scripts/
│   └── build-notebook.js         Converts `# %%` blocks in notebook.py into notebook.ipynb
└── test/
    ├── app.test.js               API health, status, registration, manual auth, chat errors
    ├── auth.test.js              Password login, cookies, auth-disabled/production, login rate limiting
    ├── config.test.js            HOST, README/env docs, detach-finalize wiring
    ├── frontend.test.js          Status labels, two-failure threshold, stop-note persistence
    ├── heroku.test.js            Node engine, Heroku docs, startup flags, SESSION_SECRET/TRUST_PROXY
    ├── notebook.test.js          Cell parsing, nbformat output, generated-notebook freshness
    ├── proxy.test.js             Mock upstream, streaming, model omission, timeouts, abort, errors
    ├── security.test.js          CORS, body limit, malformed JSON, static 404, registration 503
    ├── status.test.js            Env/manual status sources
    └── helpers/
        ├── app-server.js         Spawn/stop the app, free ports, JSON requests, cookie helpers
        └── mock-upstream.js      OpenAI-compatible mock with configurable models/chat/SSE behavior
```

---

## 4. BACKEND (server.js and other backend files)

### Backend files

- `server.js` — Express app, middleware, routes, auth routes, startup, shutdown.
- `lib/auth.js` — optional password authentication, session token signing/verification, cookie helpers, auth middleware.
- `lib/bridge.js` — bridge registration/manual state, token comparison, URL validation, model-name resolution, `/v1/models` status ping.
- `lib/chat-proxy.js` — chat request validation and proxy to the OpenAI-compatible upstream, including SSE handling and timeout/error mapping.
- `lib/rate-limit.js` — per-process in-memory fixed-window limiter factory.

### Route summary

| Method | Path | Authentication | Rate limiting | Request body | Success response |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/health` | none | none (not under `/api`) | none | `200 {"status":"ok"}` |
| `GET` | `/api/auth/status` | none | `apiLimiter` | none | `200 {"required":boolean,"authenticated":boolean}` |
| `POST` | `/api/auth/login` | password in JSON when enabled | `apiLimiter` + `loginLimiter` (5/min/IP) | `{password}` | `200 {"ok":true,"required":boolean,"authenticated":true}` + cookie, or `401` |
| `POST` | `/api/auth/logout` | none | `apiLimiter` | none | `200 {"ok":true}` + clearing cookie |
| `GET` | `/api/status` | none by default; session when `ACCESS_PASSWORD` is set | `apiLimiter` | none | `200 {"online":boolean,"model":string/null,"lastSeen":ISO string/null,"source":"heartbeat"|"manual"|"env"|null}` |
| `POST` | `/api/bridge/register` | shared `BRIDGE_TOKEN` in body `token` or `Authorization: Bearer ...` | `apiLimiter` + `registerLimiter` (30/min/IP) | JSON `{url, model?, token?}` | `200 {"ok":true,"model":string/null}` |
| `POST` | `/api/bridge/manual` | `ADMIN_TOKEN` (or `BRIDGE_TOKEN` fallback) in `Authorization: Bearer ...` or `X-Admin-Token` | `apiLimiter` only | JSON `{url, model?, token?}` | `200 {"ok":true,"model":string/null}` |
| `POST` | `/api/chat` | none by default; session when `ACCESS_PASSWORD` is set | `apiLimiter` + `chatLimiter` (20/min/IP) | JSON chat body (below) | `200` SSE stream, or `200 {"reply":string,"model"?:string}` when `stream:false` |
| `*` | `/api/*` unmatched | n/a | `apiLimiter` runs before the fallback | any | `404 {"error":"API route not found."}` |
| `GET` | `*` non-API | none | none | none | Static file from `public/`; extensionless routes get `public/index.html`; missing extensions get `404 Not found` |
| `OPTIONS` | any path | none | none (CORS middleware runs before limiters) | preflight headers | `204` when origin is absent/allowed; `403` when origin is disallowed |

### `GET /health`

- Request body: none.
- Response: `200` JSON `{"status":"ok"}`.
- No model/bridge check, no authentication, and no rate limiting.
- No documented error path.

### `/api/auth/*`

- `GET /api/auth/status` is public and returns `{required, authenticated}` with `Cache-Control: no-store`. When `ACCESS_PASSWORD` is unset, it returns `{required:false,authenticated:true}`.
- `POST /api/auth/login` accepts `{"password":"..."}`. Missing/empty password returns `400`; a wrong password or one longer than 512 characters returns `401 {"error":"Incorrect password."}`. The route is limited to 5 attempts/minute/IP in addition to the global API limit. A successful login returns `{ok:true,required:true,authenticated:true}` and sets the session cookie.
- Session design: token format `v1.<expiry-ms>.<hmac-sha256-hex>`. The HMAC key comes from `SESSION_SECRET` when set; otherwise it is SHA-256-derived from `ACCESS_PASSWORD` + `BRIDGE_TOKEN` with a context string. Tokens expire after 7 days. Verification is timing-safe and rejects malformed/expired tokens. Rotating the effective key invalidates existing cookies.
- Cookie: name `kaggle_chat_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=604800`, and `Secure` when `NODE_ENV=production` or Express sees HTTPS (`req.secure`). No `cookie-parser` dependency; cookies are parsed manually.
- `POST /api/auth/logout` clears the cookie with `Max-Age=0`. Logout is stateless: the old signed token remains cryptographically valid until expiration if an attacker already captured it; normal browsers drop it because the cookie is cleared.
- When auth is enabled, unauthenticated `/api/status` and `/api/chat` return `401 {"error":"Authentication required."}` with `Cache-Control: no-store`.

### `GET /api/status`

- Sets `Cache-Control: no-store`; requires auth only when `ACCESS_PASSWORD` is set.
- Calls `getStatus()` in `lib/bridge.js`.
- Response shape: `{"online": boolean, "model": string|null, "lastSeen": ISO-8601 string|null, "source": "heartbeat"|"manual"|"env"|null}`.
- When no bridge is configured: `{"online":false,"model":null,"lastSeen":null,"source":null}`.
- When a heartbeat is stale (older than 90 seconds): `online:false`, with the stored model, `lastSeen`, and `source:"heartbeat"` still returned.
- When a heartbeat is fresh or an env/manual bridge exists: performs `GET {baseUrl}/v1/models` (with bearer token if configured). Online requires a successful HTTP response; model name comes from the bridge metadata or the first `data[].id` from the ping. `source` is `heartbeat` for registrations, `manual` for the admin endpoint, and `env` for `MODEL_API_URL`.
- A model alias equal to the literal string `default` is normalized to `null` by `cleanModelName()`.
- Errors:
  - `401` when auth is enabled and no valid session cookie is present.
  - `429` from the API limiter: `{"error":"Too many requests. Please wait a moment and try again."}`
  - `403` from CORS: `{"error":"This origin is not allowed."}`
  - `500 {"error":"Could not check the model status."}` only if `getStatus()` throws unexpectedly; normal ping failures are caught and reported as `online:false`.

### `POST /api/bridge/register`

- Intended caller: the Kaggle notebook heartbeat.
- Request body: JSON object with:
  - `url` (required): HTTPS base URL, no path such as `/v1`, no credentials, no query/hash. Only `*.trycloudflare.com` hosts (or hosts configured through `BRIDGE_EXTRA_HOSTS`) are accepted. HTTP is not allowed for heartbeats.
  - `model` (optional): model alias, trimmed/collapsed, max 200 characters. Empty or literal `default` becomes `null`.
  - `token` (optional if sent as bearer header): shared secret.
- Authentication: body `token` takes precedence over `Authorization: Bearer <token>`. Comparison is timing-safe (`crypto.timingSafeEqual`). This route is not protected by `ACCESS_PASSWORD`.
- Success: `200 {"ok":true,"model":string|null}`. State stores `{tunnelUrl, modelName, modelToken=BRIDGE_TOKEN, lastSeen=Date.now(), source:'heartbeat'}` in memory.
- Errors:
  - `503 {"error":"Bridge registration is disabled because BRIDGE_TOKEN is not set on the website."}`
  - `401 {"error":"Invalid bridge token."}`
  - `400` with URL/validation messages:
    - `A tunnel URL is required.`
    - `The tunnel URL is not a valid URL.`
    - `The tunnel URL must not contain credentials.`
    - `The tunnel URL must use https (http is only allowed for localhost).`
    - `Use the tunnel base URL only, without a path such as /v1.`
    - `Only Cloudflare quick tunnel URLs (*.trycloudflare.com) are accepted.`
  - `429 {"error":"Too many bridge registrations. Please wait a moment."}`
  - `413 {"error":"The request is too large."}` when the JSON body exceeds the limit.
  - `400 {"error":"Invalid JSON body."}` for malformed JSON.
  - `403 {"error":"This origin is not allowed."}` for a disallowed browser origin.
  - `500 {"error":"Could not register the bridge."}` for unexpected failures.

### `POST /api/bridge/manual`

- Intended caller: an administrator, for a fixed model server/tunnel without heartbeat.
- Request body: JSON `{url, model?, token?}`. `url` may be HTTPS, or HTTP only for `localhost`/`127.0.0.1`/`::1`; it must be a base URL without a path. Unlike heartbeat registration, it does not require a `*.trycloudflare.com` host.
- Authentication: `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Token: <ADMIN_TOKEN>`. If `ADMIN_TOKEN` is unset, `BRIDGE_TOKEN` is used. Comparison is timing-safe.
- Success: `200 {"ok":true,"model":string|null}`. State stores `{tunnelUrl, modelName, modelToken=token || MODEL_API_KEY || BRIDGE_TOKEN || null, lastSeen=Date.now(), source:'manual'}`.
- Errors:
  - `503 {"error":"Manual bridge setup is disabled. Set ADMIN_TOKEN or BRIDGE_TOKEN first."}`
  - `401 {"error":"Admin authorization is required."}`
  - `400` URL validation messages as in the register route (credentials, protocol, path, malformed URL).
  - `429 {"error":"Too many requests. Please wait a moment and try again."}` (API limiter only).
  - `413` / `400` JSON/body errors and `403` CORS as above.
  - `500 {"error":"Could not configure the manual bridge."}` for unexpected failures.

### `POST /api/chat`

- Authentication: none by default. When `ACCESS_PASSWORD` is set, a valid session cookie is required and missing/expired sessions get `401` before validation or rate-limit budget is consumed by the chat limiter. CORS is not authentication.
- Request body (all fields except messages/message are optional):
  - `messages`: array of 1–40 objects `{role: "system"|"user"|"assistant", content: string}`. Content is trimmed, must be non-empty, at most 16,000 characters per message. At least one `user` message is required. Total content after trimming is at most 60,000 characters.
  - Legacy form: `message`: a string (trimmed, non-empty, max 16,000 characters), converted to one user message.
  - `systemPrompt`: optional string, max 8,000 characters; prepended as a system message if no system message already exists. The frontend does not use this field; it sends the system prompt inside `messages`.
  - `temperature`: optional number, default `0.7`; values outside 0–2 are clamped, non-numbers are rejected.
  - `max_tokens` or `maxTokens`: optional number, default `1024`; clamped to 1–4096.
  - `stream`: defaults to `true`; booleans are accepted. The string `"false"` is accepted for backward compatibility and disables streaming. Any other non-boolean value returns `400 {"error":"stream must be a boolean."}`.
- Model handling: `resolveModelName()` uses the stored alias, then a live `/v1/models` ping, then `MODEL_NAME`, otherwise `null`. The literal alias `default` is treated as unknown. If the resolved model is null, the upstream body omits `model` entirely rather than sending `"default"`.
- Body limit: `256kb` by default (`REQUEST_BODY_LIMIT` can change it).
- Success with `stream:true` (default): `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
  - Upstream SSE chunks are forwarded as-is.
  - While the stream is open, an SSE comment (`: ping`) is written every `SSE_KEEPALIVE_MS` (default 15,000 ms) to keep Heroku/proxies from closing an idle connection while the model produces its first token.
  - If the upstream returns a non-SSE JSON response, the server converts it into one SSE event:
    - `data: {"choices":[{"delta":{"content":"<reply>"}}]}`
    - `data: [DONE]`
  - Errors during a stream are sent as `data: {"error":{"message":"..."}}` followed by `data: [DONE]`.
- Success with `stream:false`: `200 {"reply": string, "model"?: string}` where reply is `choices[0].message.content` or `choices[0].text`. `model` is omitted when neither the upstream nor the bridge supplies one.
- Validation errors: `400` JSON `{"error": "..."}` with messages including:
  - `Please type a message before sending.`
  - `A conversation can contain at most 40 messages.`
  - `Each message must be an object.`
  - `Message roles must be system, user, or assistant.`
  - `Each message needs string content.`
  - `Messages cannot be empty.`
  - `Each message must be 16,000 characters or fewer.`
  - `A conversation must include a user message.`
  - `The conversation is too long. Start a new chat or remove messages.`
  - `The system prompt must be 8,000 characters or fewer.`
  - `temperature must be a number between 0 and 2.`
  - `max_tokens must be a number.`
  - `stream must be a boolean.`
  - `Please check your message and try again.` (unexpected validation failure)
- Offline / upstream errors:
  - `401 {"error":"Authentication required."}` when auth is enabled and no valid session cookie is present.
  - `503 {"error":"Kaggle notebook is offline. Start the notebook and wait for it to connect."}` when no bridge is configured or the heartbeat is stale.
  - `504 {"error":"The Kaggle notebook took too long to respond. Please try again."}` when the connection attempt times out (`UPSTREAM_CONNECT_TIMEOUT_MS`, default 30s).
  - `502 {"error":"Could not reach the Kaggle notebook. Check that the tunnel is running."}` for connection failures.
  - Upstream `401`/`403` becomes `502` with `The Kaggle notebook rejected the request. Check that BRIDGE_TOKEN and KAGGLE_BRIDGE_TOKEN match.`
  - Upstream `429` becomes `503` with `The Kaggle notebook is busy. Please try again in a moment.`
  - Upstream `404` becomes `502` with `The Kaggle notebook has no chat endpoint. Check that the OpenAI-compatible server is running.`
  - Other non-OK upstream statuses become `502` with `The Kaggle notebook returned an error. Please try again.`
  - Empty non-stream reply: `502 {"error":"The Kaggle notebook returned an empty response."}`
  - Non-stream read failure: `502` invalid response, or `504` timeout.
  - Streaming idle timeout (`UPSTREAM_IDLE_TIMEOUT_MS`, default 120s): SSE error `The Kaggle notebook stopped responding. Please try again.`
  - Streaming interruption: SSE error `The connection to the Kaggle notebook was interrupted.`
  - Streaming invalid response: SSE error `The Kaggle notebook returned an invalid response.`
  - Client disconnect: the upstream request is aborted; no error is sent to the disconnected client.
  - `429 {"error":"Too many chat requests. Please wait a moment and try again."}` from the chat limiter.
  - `413`, `400 Invalid JSON body.`, `403` CORS, and `500` general errors are also possible.

### Other routes and behaviors

- Any unmatched `/api/*` request returns `404 {"error":"API route not found."}` after the API limiter.
- `express.static('public')` serves the frontend. The catch-all now returns `404 Not found` (`text/plain`) for paths with a file extension that do not exist, while extensionless paths still receive `public/index.html` for SPA routing.
- The global error handler returns:
  - `413 {"error":"The request is too large."}` for `entity.too.large`.
  - `400 {"error":"Invalid JSON body."}` for JSON syntax errors.
  - `500 {"error":"Something went wrong."}` for other errors, unless headers were already sent.
- Startup:
  - Calls `loadLocalEnv()` before loading backend modules, then `initBridgeFromEnv()`.
  - Listens on `PORT` (default 3000) and `HOST` (default `0.0.0.0`; use `127.0.0.1` for local-only).
  - Logs whether `BRIDGE_TOKEN`, `ALLOWED_ORIGIN`, and `ACCESS_PASSWORD` are set (booleans only; no secrets), and warns when `BRIDGE_TOKEN` or `ALLOWED_ORIGIN` is missing.
  - In `NODE_ENV=production` with no `ACCESS_PASSWORD`, logs a warning that the chat interface and APIs are publicly accessible.
  - On `EADDRINUSE`, prints a message and exits with code 1.
  - Handles `SIGINT`/`SIGTERM` with a graceful `server.close()` and a forced exit after 5 seconds.

### Middleware used

- **Custom security headers** (`securityHeaders`):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- **Custom CORS allow-list** (`corsMiddleware`):
  - Requests with no `Origin` are allowed through (and `OPTIONS` without Origin gets `204`).
  - With `ALLOWED_ORIGIN` set, origins are compared after trimming trailing slashes; the list can be comma-separated.
  - With `ALLOWED_ORIGIN` empty, an Origin is allowed only when its host equals `req.get('host')`.
  - Disallowed origins get `403 {"error":"This origin is not allowed."}`.
  - Allowed origins receive `Access-Control-Allow-Origin` and `Vary: Origin`; preflights allow `GET,POST,OPTIONS`, headers `Content-Type, Authorization, X-Admin-Token`, max age 600.
  - This is not authentication; CORS only affects browsers.
- **Request logger**: logs method, path, status code, and duration only. It does not log bodies, headers, tokens, passwords, or model responses.
- **JSON body parser**: `express.json({ limit: BODY_LIMIT })`, default `256kb`; only JSON bodies are parsed.
- **Rate limiting**: custom in-memory fixed-window limiters:
  - `/api` global: 120 requests/minute/IP.
  - `/api/chat`: 20 requests/minute/IP.
  - `/api/bridge/register`: 30 requests/minute/IP.
  - `/api/auth/login`: 5 requests/minute/IP.
  - Headers: `RateLimit-Limit`, `RateLimit-Remaining`; on rejection also `Retry-After` and `429`.
  - Keys use `req.ip` or the socket remote address. `TRUST_PROXY=1` enables Express `trust proxy` with one hop.
  - Not shared between processes/instances and lost on restart.
- **Authentication**: `requireAuth` protects `/api/status` and `/api/chat` only when `ACCESS_PASSWORD` is configured. Cookie parsing and HMAC verification are implemented in `lib/auth.js` with Node's `crypto`; there is no session store.
- **Static file serving**: `express.static(path.join(__dirname, 'public'))` followed by the extension-aware SPA fallback.
- **Not present:** `helmet`, the `cors` npm package, `express-rate-limit`, compression, `cookie-parser`, server-side session storage, token revocation, CSRF tokens, request IDs, structured logging, or database middleware.

### How the real model call works

**`callModelService`: NOT IMPLEMENTED.** No function, class, variable, or file with that name exists. The current model-call implementation is `chatHandler` in `lib/chat-proxy.js`:

1. `POST /api/chat` in `server.js` runs `requireAuth`, then `chatLimiter`, then `chatHandler(req, res)`, forwarding rejected promises to Express.
2. `chatHandler` sets `Cache-Control: no-store`, validates the request body and limits, and rejects invalid input with JSON `400`.
3. It calls `getUpstreamConfig()` and `isBridgeUsable()`. If no bridge exists, or a heartbeat-sourced bridge is older than 90 seconds, it returns `503` without making any network call.
4. It resolves the model name with `resolveModelName()`: stored model name first, otherwise the live `/v1/models` ping, otherwise `MODEL_NAME`, otherwise `null`. Literal `default` aliases are normalized away.
5. It creates an `AbortController`, registers a client-close handler, and starts a connect timer.
6. It makes the real HTTP call in `lib/chat-proxy.js`:
   - `POST {baseUrl}/v1/chat/completions`
   - Headers: `Content-Type: application/json`, `Accept: text/event-stream` (or `application/json` when not streaming), and `Authorization: Bearer <modelToken>` when a token exists.
   - Body: `{messages, temperature, max_tokens, stream}` plus `model` only when a non-null model name was resolved.
7. If `stream:false`, it parses the upstream JSON reply and returns `{reply}` plus `model` when known.
8. If streaming is requested, it forwards the upstream SSE body, handles backpressure, resets an idle timer on each chunk, and converts a non-SSE JSON upstream response into a single SSE event plus `[DONE]`.
9. It maps upstream non-OK statuses to the 502/503/504 messages listed above and aborts the upstream request if the browser disconnects.

What is placeholder or external:

- The server does not hardcode a real model URL. `bridgeState` starts with `tunnelUrl: null`. A model becomes available only after `MODEL_API_URL` is set at startup, a heartbeat is accepted, or an admin calls the manual endpoint.
- `MODEL_API_URL` is optional and commented out in `.env.example`. If it is unset and no heartbeat/manual registration arrives, the real call is never reached because the offline check returns `503`.
- `kaggle/notebook.py` has a placeholder `SITE_URL = "https://your-site.onrender.com"`; the notebook refuses to start if the host still contains `your-site`.
- The default model repository and filename in the notebook are real values (`bartowski/Llama-3.2-3B-Instruct-GGUF`, `Llama-3.2-3B-Instruct-Q4_K_M.gguf`), but no model file is stored in this repository. The notebook downloads it at runtime.
- The notebook's model server, Cloudflare tunnel, and heartbeat are implemented but are external runtime components and are not running in this workspace.
- The app does not call the Hugging Face Inference API. Hugging Face is used only by `huggingface_hub.hf_hub_download()` in the notebook to download GGUF weights. The Node server only talks to an OpenAI-compatible endpoint.
- Tests now include a mock OpenAI-compatible upstream, but production code has no fake model reply.

### Environment variables read by the backend

See section 6 for the full table. Variables read by code are documented in `.env.example` and README: `HOST`, `ACCESS_PASSWORD`, `SESSION_SECRET`, `REQUEST_BODY_LIMIT`, `BRIDGE_EXTRA_HOSTS`, and `SSE_KEEPALIVE_MS`. `MODEL_API_URL` is read inside `initBridgeFromEnv()`; it is normalized to an HTTPS base URL (HTTP allowed only for loopback), given `MODEL_NAME`, and given a token from `MODEL_API_KEY` or `BRIDGE_TOKEN`.


### `server.js` (full source)

```javascript
'use strict';

const path = require('path');
const express = require('express');

function loadLocalEnv() {
  if (typeof process.loadEnvFile !== 'function') {
    return;
  }

  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not load .env:', error.message);
    }
  }
}

loadLocalEnv();

const {
  BridgeError,
  initBridgeFromEnv,
  registerBridge,
  setManualBridge,
  getStatus,
  adminAuthConfigured,
  isAdminRequest
} = require('./lib/bridge');
const { chatHandler } = require('./lib/chat-proxy');
const { createRateLimiter } = require('./lib/rate-limit');
const {
  loginHandler,
  logoutHandler,
  requireAuth,
  statusHandler
} = require('./lib/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '256kb';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
}

function corsMiddleware(req, res, next) {
  const origin = req.get('origin');

  if (!origin) {
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  }

  let isAllowed = false;

  if (ALLOWED_ORIGINS.length > 0) {
    isAllowed = ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''));
  } else {
    try {
      isAllowed = new URL(origin).host === req.get('host');
    } catch {
      isAllowed = false;
    }
  }

  if (!isAllowed) {
    if (req.method === 'OPTIONS') {
      return res.status(403).end();
    }
    return res.status(403).json({ error: 'This origin is not allowed.' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Admin-Token'
    );
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  return next();
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });

  next();
}

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(requestLogger);
app.use(express.json({ limit: BODY_LIMIT }));

const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests. Please wait a moment and try again.'
});
const chatLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Too many chat requests. Please wait a moment and try again.'
});
const registerLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many bridge registrations. Please wait a moment.'
});
const loginLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Too many login attempts. Please wait a minute and try again.'
});

app.use('/api', apiLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/status', statusHandler);
app.post('/api/auth/login', loginLimiter, loginHandler);
app.post('/api/auth/logout', logoutHandler);

app.get('/api/status', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const status = await getStatus();
    return res.json(status);
  } catch {
    console.error('Status check failed unexpectedly.');
    return res.status(500).json({ error: 'Could not check the model status.' });
  }
});

app.post('/api/bridge/register', registerLimiter, (req, res) => {
  try {
    const result = registerBridge(req.body, req.get('authorization'));
    const modelLabel = result.model ? ` for "${result.model}"` : '';
    console.log(`Bridge heartbeat accepted${modelLabel}.`);
    return res.json({ ok: true, model: result.model });
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.statusCode >= 500) {
        console.error('Bridge registration is unavailable.');
      } else {
        console.warn(`Bridge registration rejected with HTTP ${error.statusCode}.`);
      }
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error('Bridge registration failed unexpectedly.');
    return res.status(500).json({ error: 'Could not register the bridge.' });
  }
});

app.post('/api/bridge/manual', (req, res) => {
  if (!adminAuthConfigured()) {
    return res.status(503).json({
      error: 'Manual bridge setup is disabled. Set ADMIN_TOKEN or BRIDGE_TOKEN first.'
    });
  }

  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Admin authorization is required.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = setManualBridge({
      url: body.url,
      model: body.model,
      token: body.token
    });
    const modelLabel = result.model ? ` for "${result.model}"` : '';
    console.log(`Manual bridge configured${modelLabel}.`);
    return res.json({ ok: true, model: result.model });
  } catch (error) {
    if (error instanceof BridgeError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error('Manual bridge setup failed unexpectedly.');
    return res.status(500).json({ error: 'Could not configure the manual bridge.' });
  }
});

app.post('/api/chat', requireAuth, chatLimiter, (req, res, next) => {
  Promise.resolve(chatHandler(req, res)).catch(next);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large.' });
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  console.error('Unhandled request error:', error?.name || 'Error');

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ error: 'Something went wrong.' });
});

initBridgeFromEnv();

const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const bridgeTokenSet = Boolean(String(process.env.BRIDGE_TOKEN || '').trim());
  const accessPasswordSet = Boolean(String(process.env.ACCESS_PASSWORD || '').trim());
  const allowedOriginSet = ALLOWED_ORIGINS.length > 0;

  console.log(`Server is running on http://${displayHost}:${PORT}`);
  console.log(
    `Startup config: BRIDGE_TOKEN=${bridgeTokenSet}, ALLOWED_ORIGIN=${allowedOriginSet}, ACCESS_PASSWORD=${accessPasswordSet}`
  );

  if (!bridgeTokenSet) {
    console.warn('BRIDGE_TOKEN is not set. Notebook heartbeats will be rejected.');
  }

  if (!allowedOriginSet) {
    console.warn(
      'ALLOWED_ORIGIN is not set. Only same-host browser origins are allowed. Set it in production.'
    );
  }

  if (!accessPasswordSet && process.env.NODE_ENV === 'production') {
    console.warn(
      'ACCESS_PASSWORD is not set. The chat interface and APIs are publicly accessible in production.'
    );
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the current server or start this app on a different port with PORT=3001 npm start.`
    );
    process.exit(1);
  }

  console.error('Server error:', error.name || 'Error');
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down...`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

```

---

## 5. FRONTEND (public/index.html, styles.css, app.js)

### Main UI components

- **Sidebar** (`#sidebar`):
  - `#sidebar-close` (mobile close), `#new-chat`, `#conversation-list`, and `#empty-conversations`.
  - Conversation rows are built in `renderSidebar()`: a `.conversation-select` button with `.conversation-title` and `.conversation-meta` ("N messages"), plus rename (`✎`) and delete (`×`) action buttons. The active row gets `.active` and `aria-current="true"`.
  - Sidebar note: chats/settings are stored in this browser only.
  - No settings/theme controls live in the sidebar; those are in the top bar.
- **Top bar**:
  - Mobile menu button `#sidebar-toggle` (with `aria-expanded`/`aria-controls`).
  - Brand block.
  - Status badge `#status-badge[data-state]` with `.status-dot` and `#status-text`; it has `role="status"` and an `aria-live` region. There is no separate model/time DOM node; the model alias is appended to the badge text and the tooltip carries `Last heartbeat` details.
  - `#theme-toggle` ("Dark"/"Light"), `#settings-button` ("Settings"), and `#auth-logout` ("Sign out", hidden unless a required password session is active).
- **Chat area**:
  - `#welcome-screen` with a welcome card and four `.prompt-button` example prompts.
  - `#messages` for message articles and `#typing-indicator` for the waiting animation.
  - `#error-banner` (`role="alert"`) and `#offline-notice` (`role="status"`) sit between the message area and composer; there is no toast component.
- **Composer** (`#chat-form`):
  - Labeled `#message-input` textarea (`rows="1"`, `maxlength="16000"`, placeholder "Type your message..."), hidden hint `#composer-hint`, `#stop-button` (hidden unless waiting), and `#send-button`.
  - Enter sends; Shift+Enter inserts a newline. The textarea auto-sizes up to 180 px.
  - The system prompt, temperature, and output-token controls are in the settings dialog, not in a composer drawer; there is no character counter.
- **Settings dialog** (`#settings-dialog`):
  - Native `<dialog>` containing `#settings-form`, close button `#settings-close`, system prompt textarea `#system-prompt` (max 8,000), temperature range `#temperature` (0–2 step 0.1 with `#temperature-value`), max-token number input `#max-tokens` (1–4096), `#settings-reset`, and save button.
  - Saving stores settings in `localStorage`; reset restores defaults. Clicking the backdrop/outside closes the dialog.
- **Auth dialog** (`#auth-dialog`):
  - Native `<dialog>` with `#auth-form`, heading "Access required", copy, password input `#auth-password` (`maxlength="512"`, `autocomplete="current-password"`), error region `#auth-error`, and `#auth-submit` ("Unlock").
  - It has no cancel button. `cancel` events (Escape) are prevented, so the dialog cannot be dismissed while login is required; there is also no outside-click handler that closes it.
- **Message UI**:
  - Both user and assistant messages are rendered through the custom Markdown renderer inside `.message-bubble`; of course, user input is HTML-escaped first.
  - Fenced code blocks get a `.code-block` wrapper, language label, and `Copy` button.
  - Streaming shows `#typing-indicator` until the first delta, then replaces it with the growing assistant bubble. There is no separate animated cursor element.
  - The stop button aborts the active SSE stream; partial text is preserved (see below).
- **Theme**: initial theme follows `prefers-color-scheme`; the toggle stores `aiChat.theme.v1` in `localStorage`.
- **Responsive/mobile**: the sidebar is an off-canvas drawer at the 900px breakpoint with `#sidebar-backdrop`; compact topbar/composer rules apply at 640px and below.

### Browser state and persistence

The top-level `state` object currently contains:

- `conversations`: saved conversation objects `{id,title,createdAt,updatedAt,messages}`.
- `activeId`: selected saved conversation id (empty string means a draft).
- `draft`: a new unsaved conversation object.
- `settings`: `{systemPrompt,temperature,maxTokens}`.
- `theme`: `light` or `dark`.
- `online`: `true`, `false`, or `null` (checking).
- `statusModel`, `statusLastSeen`, `statusSource`, `statusFailures`, `statusInFlight`.
- `authRequired`, `authAuthenticated`.
- `waiting`: whether a chat request is active.
- `abortController`: the current `AbortController`.
- `stream`: current stream state or `null`.

Constants (not UI state): `MAX_SAVED_CONVERSATIONS = 50`, `MAX_MESSAGES_PER_CONVERSATION = 200`, `CONTEXT_MESSAGE_LIMIT = 40`, `MAX_HISTORY_CHARS = 16000`, `STATUS_POLL_MS = 10000`.

Storage keys:

- `aiChat.conversations.v1`: conversations array.
- `aiChat.activeId.v1`: active conversation id.
- `aiChat.settings.v1`: settings object.
- `aiChat.theme.v1`: `light` or `dark`.

`readStorage`, `readJsonStorage`, `writeStorage`, and `removeStorage` catch storage errors. `saveConversations()` first trims to 50 conversations and 200 messages each; if the write still fails, it retries with at most 10 conversations and 50 messages each. It returns a boolean but does not display a warning to the user; data is not synced to the server.

`buildRequestMessages()` sends the last messages within a 16,000-character budget (including the system prompt), with at most 40 messages. The full history remains in `localStorage`.

### Auth flow

- `initialize()` calls `checkAuthStatus()` before the first status poll.
- `checkAuthStatus()` calls `GET /api/auth/status`, sets `state.authRequired` and `state.authAuthenticated`, updates the sign-out button/composer, and shows the auth dialog when a password is required but the browser is not authenticated.
- If the status endpoint later returns `401`, `markUnauthorized()` clears the online/model/failure state, shows the dialog, and disables the composer.
- Submitting `#auth-form` calls `POST /api/auth/login` with `{password}`. Success stores the server-set cookie, hides the dialog, clears the form/error, and refreshes status; failure shows the server error and refocuses the password field.
- `#auth-logout` calls `POST /api/auth/logout`, sets the session state unauthenticated, clears status, detaches/finalizes the active stream, updates the badge/composer, and shows the auth dialog when auth is required. Because sessions are stateless, logout clears the browser cookie but cannot revoke a copied token.
- A `401` from `/api/chat` calls `markUnauthorized()` and surfaces `Enter the access password to continue.`

### Status display and polling

- `refreshStatus()` runs immediately, then every 10 seconds via `setInterval`; it also runs when the browser comes online and when the tab becomes visible (with an in-flight guard to avoid overlapping requests).
- `applyStatusResult()` calls `ChatUI.evaluateStatus(previous, result)`:
  - An online result sets `online:true`, resets failures to 0, and updates model/lastSeen/source.
  - Any failed poll increments failures. With fewer than 2 failures, `online` keeps its previous value (or stays `null`), so the first failure does not immediately force Offline. The second consecutive failure sets `online:false`.
  - A `401` is handled by `markUnauthorized()` and does not increment the failure count.
- `statusPresentation()` in `public/ui-helpers.js`:
  - `online:null` → `Checking...`.
  - `online:false` → `Offline`; title is `Kaggle notebook is offline` for heartbeat source, otherwise `The model connection is offline`.
  - `source:"heartbeat"` → `Kaggle connected`; the title includes `Last heartbeat: <local time>` when `lastSeen` exists.
  - `source:"manual"`/`"env"` → `Model connected`.
  - Unknown/missing source → `Connected`.
  - If a model alias exists, the text becomes `<label> · <model>`.
- The composer is disabled only when `state.online === false` or auth is required and unauthenticated. While checking (online `null`), the input remains enabled; the send button is additionally disabled while `state.waiting` is true. Offline mode shows `#offline-notice` and changes the placeholder; auth mode changes it to the access-password prompt.

### Streaming and detach behavior

- `sendMessage()` trims input, refuses to send while waiting or when `state.online === false`, appends the user message, creates a draft/active conversation, and sends `POST /api/chat` with `stream:true`, the recent-message budget, temperature, and max tokens.
- Stream state is `{conversation,text,message,bubble,raf,finalized}`. `state.stream` points at it; `state.abortController` owns cancellation.
- Incoming `data:` events are parsed by `extractSseEvents`/`handleSseEvent`; `[DONE]` and empty data are ignored. Error objects in the SSE payload throw and are shown as errors. Deltas update the assistant message and are rendered on the next animation frame.
- If the upstream returns JSON instead of SSE despite `stream:true`, the app accepts a `reply` string and appends it to the same stream.
- `stopActiveStream()` (the stop button) and `detachActiveStream()` abort the controller. Detach now:
  - Aborts the controller.
  - If `state.stream` exists, calls `finalizeStream(streamState, true, '')`.
  - Otherwise clears waiting/typing state and updates the composer.
- `finalizeStream()` is guarded by `streamState.finalized`; it cancels pending rendering, appends `\n\n*Stopped.*` for aborted partial text via `ChatUI.finalizeStreamText`, updates the bubble, removes an empty assistant placeholder, saves conversations, clears `state.stream`/`state.abortController`/`state.waiting`, hides the typing indicator, and focuses the input. Errors are shown in `#error-banner` and, when no bubble exists, as an assistant error message.
- Abort errors are treated as a manual stop, not as a failure.

### Markdown, code blocks, and XSS posture

- `renderMarkdown()` is a custom line-based renderer. It supports fenced code blocks, headings, horizontal rules, blockquotes, unordered/ordered lists, paragraphs, and line breaks.
- Inline Markdown (after HTML escaping) supports inline code, links (only `http:`/`https:` URLs through `sanitizeUrl`), bold/italic, and strikethrough. Link output uses `target="_blank"` and `rel="noopener noreferrer"`.
- Fenced code is escaped before insertion and wrapped in `.code-block` with a copy button; raw HTML inside code is displayed, not executed.
- User messages use the same Markdown renderer as assistant messages. The renderer escapes all input before adding its own markup, and the server sets a strict CSP, but it is still a limited regex parser rather than a formally audited sanitizer.
- Code copy uses `navigator.clipboard.writeText()` with a `document.execCommand('copy')` fallback.


### `public/app.js` (full source)

```javascript
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
  maxTokens: 1024
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

```

---

### `public/index.html` structural summary

- Document shell with `lang="en"` and `data-theme="light"`, viewport/theme-color meta tags, title "AI Chat", a description, and `/styles.css`.
- Sidebar, mobile backdrop, top bar, welcome screen, messages, typing indicator, error banner, offline notice, and composer as described above.
- Settings `<dialog>` and auth `<dialog>` (both native dialogs). The settings dialog has a close button, system-prompt/temperature/max-token fields, reset, and save; the auth dialog has only the password form and Unlock button.
- Script order: `/ui-helpers.js` first, then `/app.js`; both are loaded with `defer` after the DOM. The helpers file defines `window.ChatUI` and is also loadable with `require()` in tests.
- No inline JavaScript, CDN, or external assets. All colors/layout are in `public/styles.css`.
- Accessibility details present: ARIA labels on icon buttons, dialog `aria-labelledby`/`aria-describedby`, status live regions, alert/status roles, form labels, hidden composer hint, and focus handling in `app.js`. There is no skip link.

### `public/styles.css` structural summary

- CSS custom properties define light and dark themes (`:root` and `[data-theme="dark"]`); theme is applied through the `data-theme` attribute rather than a media-query-only fallback.
- Layout: 292px sidebar, flexible chat column, composer at the bottom of the column, and a scrollable message list.
- Components: sidebar/conversation rows, status badge/dot, welcome card/prompts, messages, typing indicator, error banner, offline notice, code blocks/toolbars, composer, auth/settings dialogs, buttons, and focus states.
- Auth dialog reuses the settings dialog layout with password field styling and inline error text.
- Responsive breakpoints at 900px, 640px, and 520px, plus hover-none and reduced-motion media queries; the mobile sidebar uses transform/backdrop rather than a separate layout.
- There are no external fonts or images; icons/characters are text or inline SVG in `index.html`/`app.js`.

---

## 6. ENVIRONMENT AND CONFIG

### `.env.example` (full current contents)

```dotenv
# Shared secret between the Kaggle notebook and this website.
# Set the Kaggle Secret KAGGLE_BRIDGE_TOKEN to the same long random value.
# Example: openssl rand -hex 32
BRIDGE_TOKEN=replace-with-a-long-random-string

# Port and bind address for the Express server.
# Use HOST=127.0.0.1 for local-only access.
PORT=3000
HOST=0.0.0.0

# Browser origin allowed to call the API. Use your deployed origin in production.
# Multiple origins can be comma-separated. No trailing slash.
ALLOWED_ORIGIN=http://localhost:3000

# Optional password for the chat UI and the protected status/chat APIs.
# Leave empty to keep the site public. Use a long random value in production.
# ACCESS_PASSWORD=replace-with-a-long-random-password

# Optional independent key for signing session cookies. If unset, the key is
# derived from ACCESS_PASSWORD + BRIDGE_TOKEN. Set this to keep sessions valid
# when rotating one of those values.
# SESSION_SECRET=replace-with-another-long-random-string

# Set to production on HTTPS deployments so session cookies are marked Secure.
# NODE_ENV=production

# Maximum JSON request body size (Express size syntax).
# REQUEST_BODY_LIMIT=256kb

# Extra hostnames accepted for bridge heartbeats in addition to
# *.trycloudflare.com (comma-separated, no wildcard).
# BRIDGE_EXTRA_HOSTS=model.example.com

# Optional fallback when the heartbeat is not used.
# Use the tunnel/model server base URL only (no /v1 path).
# MODEL_API_URL=https://example.trycloudflare.com
# MODEL_NAME=llama-3.2-3b
# MODEL_API_KEY=optional-model-bearer-token

# Optional separate token for POST /api/bridge/manual.
# If unset, ADMIN_TOKEN falls back to BRIDGE_TOKEN.
# ADMIN_TOKEN=replace-with-a-separate-long-random-string

# Set to 1 when running behind Render/Railway/Heroku so rate limiting sees
# the real client IP from the proxy.
# TRUST_PROXY=1

# Optional timeouts in milliseconds.
# STATUS_PING_TIMEOUT_MS=4000
# UPSTREAM_CONNECT_TIMEOUT_MS=30000
# UPSTREAM_IDLE_TIMEOUT_MS=120000

# SSE keep-alive comment interval in milliseconds. Keeps Heroku/proxies from
# closing an idle stream while the model loads its first token. Default 15000.
# SSE_KEEPALIVE_MS=15000
```

### `.gitignore` (exact contents)

```text
node_modules/
.env
npm-debug.log*
.DS_Store
```

### Environment variables expected by the Node code

| Variable | Required? | Default in code | Where used | Purpose / notes |
| --- | --- | --- | --- | --- |
| `PORT` | no | `3000` | `server.js` | HTTP listen port. Invalid values fall back to 3000. |
| `HOST` | no | `0.0.0.0` | `server.js` | Listen interface. Use `127.0.0.1` to restrict to localhost; container platforms usually need `0.0.0.0`. |
| `NODE_ENV` | no | unset/development | `lib/auth.js` | When exactly `production`, session cookies are marked `Secure`. Use only on HTTPS deployments. |
| `ACCESS_PASSWORD` | no | empty | `lib/auth.js`, `server.js` | Enables password protection for `/api/status` and `/api/chat` when non-empty after trimming. No minimum length enforced; login rejects passwords over 512 characters. A production startup warning is logged when unset. |
| `SESSION_SECRET` | no | derived | `lib/auth.js` | Optional independent HMAC key for session cookies. If empty, the key is SHA-256-derived from `ACCESS_PASSWORD` + `BRIDGE_TOKEN`. |
| `ALLOWED_ORIGIN` | no | empty | `server.js` | Comma-separated browser origins. Trailing slashes are trimmed. If empty, same-host origins are allowed. It does not protect APIs by itself. |
| `BRIDGE_TOKEN` | effectively required for heartbeat | empty | `lib/bridge.js`, notebook | Shared secret for heartbeat registration, fallback admin secret, and fallback upstream bearer token. Heartbeat registration returns 503 when unset. |
| `ADMIN_TOKEN` | no | empty | `lib/bridge.js` | Separate secret for `POST /api/bridge/manual`; falls back to `BRIDGE_TOKEN`. |
| `MODEL_API_URL` | no | empty (commented) | `lib/bridge.js` | Fixed OpenAI-compatible base URL. Only HTTPS, except HTTP for loopback; a non-root path such as `/v1` is rejected. Query/hash are removed and `/v1` is appended later. Creates `source:"env"`. |
| `MODEL_NAME` | no | empty | `lib/bridge.js` | Optional alias sent as `model`; empty or literal `default` becomes `null`, so the field is omitted upstream. |
| `MODEL_API_KEY` | no | empty | `lib/bridge.js` | Bearer token for the fixed/manual model endpoint; falls back to `BRIDGE_TOKEN`. Not stored in browser code. |
| `BRIDGE_EXTRA_HOSTS` | no | empty | `lib/bridge.js` | Comma-separated hostnames accepted for heartbeat registration in addition to `*.trycloudflare.com`. No schemes or wildcards. |
| `REQUEST_BODY_LIMIT` | no | `256kb` | `server.js` | Express JSON body size string (`256kb`, `1mb`, etc.). |
| `SSE_KEEPALIVE_MS` | no | `15000` | `lib/chat-proxy.js` | Interval for SSE `: ping` comments while a stream is open; clamped to 100-300000 ms. |
| `STATUS_PING_TIMEOUT_MS` | no | `4000` | `lib/bridge.js` | Timeout for the `/v1/models` status check; clamped to 100–30000 ms. |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | no | `30000` | `lib/chat-proxy.js` | Time to establish the upstream chat request; clamped to 1000–120000 ms. |
| `UPSTREAM_IDLE_TIMEOUT_MS` | no | `120000` | `lib/chat-proxy.js` | Maximum idle time while waiting for upstream stream data/non-stream response; clamped to 1000–600000 ms. |
| `TRUST_PROXY` | no | unset | `server.js` | Set to exactly `1` to trust one proxy hop for client IP/rate limiting. Set only when deployed behind a trusted reverse proxy. |
| `KAGGLE_BRIDGE_TOKEN` | notebook only | none | `kaggle/notebook.py` | Kaggle Secret read by the notebook; must equal the website's `BRIDGE_TOKEN`. Not read by Node. |
| `HF_TOKEN`/Hugging Face login | notebook only | none | `kaggle/notebook.py` | Optional Hugging Face token for gated/rate-limited model downloads. Not read by Node. |

There are no other environment variables read by `server.js` or `lib/*.js`; a search of `process.env.*` confirms this list. No environment variable points to the Kaggle API itself; the app only uses the tunnel URL supplied by heartbeat/manual/env configuration.

### Kaggle notebook configuration and generation

- `kaggle/notebook.py` is the source of truth. It contains these settings near the top:
  - `SITE_URL`: website base URL; must not still contain `your-site`.
  - `REPO_ID`: default `bartowski/Llama-3.2-3B-Instruct-GGUF`.
  - `FILENAME`: default `Llama-3.2-3B-Instruct-Q4_K_M.gguf`.
  - `MODEL_ALIAS`: sent to the website as the model name; default `llama-3.2-3b`.
  - `N_CTX`: context size, default `8192`.
  - `HEARTBEAT_SECONDS`: default `30`.
  - `N_GPU_LAYERS`: `-1` attempts to offload all layers.
  - `BRIDGE_TOKEN`: read from Kaggle Secrets via `UserSecretsClient` as `KAGGLE_BRIDGE_TOKEN`.
  - `HF_TOKEN`: optional Hugging Face token for the download.
- `npm run build:notebook` runs `scripts/build-notebook.js`, which:
  - Reads `notebook.py` as text.
  - Splits on `# %%` markers.
  - Treats blocks beginning with further `# %% [markdown]` as markdown cells, strips the marker, and converts Python comment prefixes (`# `) to markdown.
  - Treats all other blocks as Python code cells, trims blank lines, and skips empty blocks.
  - Emits nbformat 4.5 JSON with `metadata.language_info` for Python and empty outputs/execution counts.
  - Writes `kaggle/notebook.ipynb`; the generated file is intended to be uploaded to Kaggle.
- The generated notebook currently has **18 cells: 10 markdown and 8 code**. Its first markdown cell explains enabling Internet/GPU, adding `KAGGLE_BRIDGE_TOKEN` and optional `HF_TOKEN`, and setting `SITE_URL` to the Heroku app URL. `test/notebook.test.js` verifies this structure and checks that the committed notebook matches a fresh generation.
- The notebook does not contain secrets or outputs. Kaggle Secrets are read at runtime by the notebook, not embedded in the `.ipynb`.

---

## 7. TESTS

How to run:

```powershell
npm test
```

The exact script is `node --test test/*.test.js`. On this Windows/Node setup, `node --test test` fails with `Cannot find module ...\test`; use the npm script or the glob form shown above.

**Latest run in this review:** `npm test` produced **56 tests, 56 passed, 0 failed** in about 6.2 seconds. `node --check` also passed for `server.js`, `lib/auth.js`, `lib/bridge.js`, `lib/chat-proxy.js`, `public/app.js`, `public/ui-helpers.js`, `scripts/build-notebook.js`, the test helpers, and `test/config.test.js`.

Test files and coverage:

| File | Tests | Coverage |
| --- | ---: | --- |
| `test/app.test.js` | 10 | Health, offline status shape (`source:null`), chat validation/503, registration token/URL validation, heartbeat source/status ping, unreachable bridge, manual admin auth, bearer registration. |
| `test/auth.test.js` | 7 | Public auth status, protected status/chat 401, login wrong/correct with cookie attributes, logout clearing cookie, auth-disabled mode, production `Secure` cookie, login rate limiting. |
| `test/config.test.js` | 4 | `HOST` binding/default, `.env.example` documentation, README notebook/local-binding documentation, detach-finalize wiring. |
| `test/frontend.test.js` | 7 | Heartbeat vs manual/env labels, unknown source, checking/offline distinction, two-failure threshold, persisted stop note, auth prompt logic. |
| `test/heroku.test.js` | 8 | Node 22 engine/Procfile, Heroku README/H12 docs, new env docs, startup boolean log, production warning, `SESSION_SECRET` isolation, fallback key derivation, `TRUST_PROXY` IP/Secure cookie behavior. |
| `test/notebook.test.js` | 3 | Cell parsing, generated nbformat structure/intro, committed notebook freshness. |
| `test/proxy.test.js` | 10 | Mock upstream non-stream success, model omission (including literal `default`), `"false"` streaming, invalid stream rejection, SSE forwarding with `[DONE]`, SSE keep-alive, status-code mapping, idle timeout, client abort. |
| `test/security.test.js` | 5 | Static extension 404 vs SPA fallback, CORS allow/deny, oversized body, malformed JSON, registration disabled without `BRIDGE_TOKEN`. |
| `test/status.test.js` | 2 | `MODEL_API_URL` env source and manual source through `/api/status`. |

Notes about the tests:

- Tests spawn the Express app on free ports through `test/helpers/app-server.js`; they do not use the real tunnel, Kaggle, Hugging Face, or a real model.
- `test/helpers/mock-upstream.js` implements an OpenAI-compatible `/v1/models` and `/v1/chat/completions` server, with configurable JSON, SSE (including `data: [DONE]`), errors, and delays.
- Tests set `NODE_ENV=test`, `HOST=127.0.0.1`, short timeouts, and clear `ACCESS_PASSWORD`/`MODEL_*` by default. Some auth/status tests deliberately spawn additional servers with different env values and close them afterward.
- `test/app.test.js` still contains its own local `startServer` helper rather than importing the shared helper; the other tests use the shared helper. This duplication is harmless but could be consolidated later.
- There is no browser automation (Playwright/Puppeteer), visual regression test, load test, fuzzing, or real-network integration test.

---

## 8. RUN CHECK

What happens in a fresh local environment:

```powershell
npm install        # installs express only (package-lock already present)
npm test           # 56 tests pass; no external services required
npm start          # starts http://localhost:3000 by default on HOST=0.0.0.0
npm run build:notebook  # regenerates kaggle/notebook.ipynb from notebook.py
```

With the default environment and no heartbeat:

- `GET /health` returns `200 {"status":"ok"}`.
- `GET /api/status` returns `200 {"online":false,"model":null,"lastSeen":null,"source":null}` (or `401` if `ACCESS_PASSWORD` is set and no session cookie exists).
- `POST /api/chat` returns `503` after authentication because no bridge is configured. If `ACCESS_PASSWORD` is set, it returns `401` first.
- The UI polls every 10 seconds; before a successful connection it shows `Checking...`, and after two consecutive failures it shows `Offline` (the first failure keeps the prior online/checking state).

When `ACCESS_PASSWORD` is set:

- The first browser load shows the unlock dialog. The password is exchanged for an HMAC-signed cookie; the password itself is never stored in browser storage.
- `/api/status` and `/api/chat` remain locked until login; `/health`, `/api/auth/*`, and heartbeat registration remain public (registration still requires `BRIDGE_TOKEN`).
- Logout clears the cookie and shows the unlock dialog again. Because sessions are stateless, a previously copied token is not revoked server-side.

When `BRIDGE_TOKEN` is missing:

- The server logs a warning at startup.
- `/api/bridge/register` returns `503`; manual setup also returns `503` unless `ADMIN_TOKEN` is set.
- An env-based `MODEL_API_URL` can still work without `BRIDGE_TOKEN`, but its upstream token may be unset.

The run check was performed for the test suite and syntax checks in this review; no long-running server, real tunnel, or Kaggle notebook was left running.

---

## 9. KAGGLE NOTEBOOK INTEGRATION

How the notebook connects to the app:

1. **Install dependencies** — installs `huggingface_hub` and `llama-cpp-python[server]` from the `abetlen/llama-cpp-python` wheel index.
2. **Read configuration and secrets** — `SITE_URL`, model repo/file/alias, context size, GPU layers, and the `KAGGLE_BRIDGE_TOKEN` secret. The notebook stops with an error if `SITE_URL` still contains `your-site`. It also fetches `HF_TOKEN` if available.
3. **Download the model** — `hf_hub_download()` downloads the configured GGUF file, with optional `HF_TOKEN`.
4. **Start the OpenAI-compatible server** — `llama_cpp.server` serves on `127.0.0.1:8000` with the bridge token as API key, configured context/GPU layers, and waits for `/v1/models` to respond.
5. **Start Cloudflare Tunnel** — downloads `cloudflared` for Linux amd64, runs a quick tunnel to the local server, and extracts `https://*.trycloudflare.com` from the tunnel output.
6. **Heartbeat the website** — every 30 seconds (`HEARTBEAT_SECONDS`), POSTs `{url, model, token}` to `POST {SITE_URL}/api/bridge/register`; non-200 responses are reported. The website treats a heartbeat as stale after 90 seconds.
7. **Keep the notebook alive** — prints the tunnel URL/model alias and sleeps in a loop; the notebook must remain running for the tunnel and model server to stay available.

Exact integration points:

- The notebook and website share `KAGGLE_BRIDGE_TOKEN` / `BRIDGE_TOKEN`.
- The notebook's `llama_cpp.server` must expose OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`.
- Website chat calls use `Authorization: Bearer <BRIDGE_TOKEN>` (or the configured model token) when a token is present.
- The website accepts only Cloudflare quick-tunnel hosts by default for heartbeats; additional hostnames require `BRIDGE_EXTRA_HOSTS`. Manual admin registration accepts other hosts and loopback HTTP.
- The notebook alias (`MODEL_ALIAS`) is used for UI display and as the upstream `model` value. The website no longer sends `"default"` if no alias is available.

Caveats:

- The notebook has not been executed in this environment. It requires Internet enabled in Kaggle, a GPU runtime, enough disk/RAM for the GGUF file, and outbound access to Hugging Face and Cloudflare.
- The Cloudflare quick-tunnel URL changes when the notebook restarts; the heartbeat updates the website automatically, but stale URLs may remain in memory until the next heartbeat/status check.
- `cloudflared` and Python package versions are not pinned, so runtime behavior may change over time.
- Kaggle session time limits and resource limits apply; the app cannot keep the model online after the notebook stops.
- The notebook is the only model host. The Node server is a proxy and does not run inference.

**To upload to Kaggle:** upload `kaggle/notebook.ipynb` (not `notebook.py`). After editing `notebook.py`, run `npm run build:notebook` and commit the regenerated `.ipynb`; `test/notebook.test.js` fails if the two are out of sync.

---

## 10. PROBLEMS AND RISKS

### High priority

1. **No real model endpoint runs by default.** With empty `.env` and no heartbeat, the app is offline and chat returns 503. This is expected for development but means the repository is not a self-contained chatbot.
2. **Bridge state is process-local and ephemeral.** Registrations, model metadata, rate-limit counters, and login limits live in memory. A restart loses the bridge; multiple instances do not share state; serverless deployments with more than one instance can behave inconsistently.
3. **Password protection is optional and off by default.** If `ACCESS_PASSWORD` is unset, anyone who can reach the server can use `/api/status` and `/api/chat` (subject to rate limits and bridge availability). This is documented but still a deployment risk.
4. **Session logout is not revocation.** Signed cookies are stateless and valid for 7 days. Clearing the cookie does not invalidate a copied token. Changing `ACCESS_PASSWORD` does invalidate all existing tokens because the HMAC key changes, but there is no per-session revocation.
5. **Login brute-force protection is in-memory.** The 5/minute/IP limiter resets on restart, is per process, and can be evaded with distributed IPs or by bypassing the proxy. Use a strong password and HTTPS.
6. **The manual bridge endpoint can reach arbitrary admin-supplied URLs.** It is protected by `ADMIN_TOKEN`/`BRIDGE_TOKEN`, allows loopback HTTP, and has no separate allow-list. A compromised admin token enables SSRF against internal services. Heartbeat registration is stricter (`*.trycloudflare.com` by default).
7. **The manual/bridge bearer tokens are sent to the upstream.** The app sends the configured model token in the `Authorization` header. Treat `BRIDGE_TOKEN`, `ADMIN_TOKEN`, and `MODEL_API_KEY` as secrets; the request logger does not include them, but a compromised model endpoint receives them.
8. **Cloudflare quick tunnels are not a production SLA.** URLs rotate, tunnels can drop, and the free service may rate-limit or fail. The app handles staleness but cannot keep the model online.

### Correctness and reliability

1. **Context-size mismatch.** The browser trims requests to a 16,000-character budget, while the API accepts up to 60,000 characters from direct clients. The default notebook model context is 8,192 tokens. Long direct-API conversations can still exceed the model context and fail upstream instead of being rejected locally. Token-aware limits would be more accurate.
2. **History only lives in the browser.** There is no server-side conversation storage or sync across devices. If `localStorage` writes fail, `saveConversations()` retries with a trimmed history (at most 10 conversations/50 messages each) but does not warn the user.
3. **Failed requests are not stored in history.** Partial successful streams are saved; thrown network/HTTP errors generally are not added to the saved assistant message except where the streaming error path writes content.
4. **Status polling is still interval-based.** Two failures reduce flicker, but after a previously online bridge the UI can take up to roughly 20 seconds to show Offline. The first failed poll retains the prior state, and the composer is disabled only once `online` becomes false. Status checks do not push updates; they poll.
5. **Status `lastSeen` semantics differ by source.** Heartbeat registrations update `lastSeen` on each heartbeat; env/manual modes set it at initialization. The UI intentionally shows "Last heartbeat" only for `source:"heartbeat"`.
6. **Environment/manual status can be stale.** Env and manual bridges do not have a heartbeat freshness cutoff; they rely on the live `/v1/models` ping. A failed ping marks the status offline but does not clear the configured state.
7. **Rate limits are fixed-window, not smooth.** Bursts at window boundaries are possible, and clients behind a shared NAT share an IP bucket. `TRUST_PROXY` must match the actual proxy topology.
8. **The server may be run behind a platform proxy that terminates TLS.** `req.secure` depends on Express trust-proxy settings; production `Secure` cookies require the deployment to be HTTPS. If `NODE_ENV=production` is set on plain HTTP, login cookies will not be sent back.
9. **Notebook freshness depends on a build step.** Editing `notebook.py` without running `npm run build:notebook` leaves Kaggle using an older notebook; the test catches it only if run before upload.
10. **Notebook and app version drift.** The notebook expects `/v1/models` and `/v1/chat/completions`; changes to the website contract or token handling must be mirrored in the notebook.

### Fixed in this revision

- Generated `kaggle/notebook.ipynb` now exists, is upload-ready, and is checked for freshness.
- Stream `"false"` is accepted while other non-booleans are rejected.
- Literal model `"default"` is no longer sent upstream; unknown models are omitted.
- Status includes `source`, and the UI distinguishes Kaggle heartbeat from manual/env model connections.
- The UI waits for two consecutive failures before showing Offline.
- Detaching a stream finalizes partial output with a persisted stop note instead of dropping it.
- Missing static files with extensions return 404 while SPA routes still serve `index.html`.
- `HOST` is configurable and documented.
- Optional `ACCESS_PASSWORD` authentication and logout are implemented.
- `SESSION_SECRET` signing is supported, with fallback derivation from `ACCESS_PASSWORD` + `BRIDGE_TOKEN`.
- `TRUST_PROXY=1` is documented and tested for forwarded client IPs and HTTPS `Secure` cookies.
- SSE keep-alive comments are sent every 15 seconds while a stream waits for output.
- Startup logs flag presence (never values) for `BRIDGE_TOKEN`, `ALLOWED_ORIGIN`, and `ACCESS_PASSWORD`; production warns when no password is set.
- `HOST`, `ACCESS_PASSWORD`, `SESSION_SECRET`, `REQUEST_BODY_LIMIT`, `BRIDGE_EXTRA_HOSTS`, and `SSE_KEEPALIVE_MS` are documented in `.env.example` and README.
- README now points to `notebook.ipynb` for upload, documents local-only `HOST`, and includes a single-Eco-dyno Heroku deployment section.

### Security

1. **Markdown rendering uses escaped custom HTML.** User content is not rendered as HTML, and fenced code is escaped before adding code UI, but the inline Markdown renderer is regex-based and not a formally audited sanitizer. The CSP reduces script injection impact. Avoid rendering untrusted HTML without a dedicated sanitizer if the renderer changes.
2. **No TLS in the Node app.** Deploy behind an HTTPS reverse proxy/platform. Session cookies and bridge tokens must not traverse plain HTTP in production.
3. **CSRF is mitigated but not token-based.** Session cookies use `SameSite=Strict`, and mutating APIs are JSON. There is no CSRF token; cross-site form posts do not send JSON, but do not weaken CORS or cookie attributes.
4. **CORS is not authentication.** The allow-list protects browser origins only. Curl/server clients can still call the API unless `ACCESS_PASSWORD` is enabled.
5. **No account model, roles, audit log, or per-user tokens.** Anyone with the password shares the same access. There is no lockout beyond the in-memory rate limit.
6. **Secrets in environment variables.** Render/Heroku/Kaggle secret stores are the intended mechanism. `.env` is gitignored; `.env.example` contains placeholders only.
7. **Bridge registration is public but requires the shared secret.** The secret is sent in the heartbeat JSON body or bearer header. Keep it long/random and rotate it if leaked; rotating it invalidates heartbeat auth and may invalidate upstream auth.
8. **Prompt injection is inherent to chat.** The model may follow instructions in user content; this app does not add tool execution, so the blast radius is limited to generated text and upstream resource use.
9. **No dependency scanning/CI.** `express` is the only runtime dependency, but `npm audit`/Dependabot are not configured.

### Documentation and repository

- `README.md` is updated for auth, notebook upload, HOST, status sources, environment variables, API shapes, and tests. Review it after any future API change.
- `PROJECT_OVERVIEW.md` is the detailed reference; this revision refreshes the narrative and embedded source blocks. It is tracked in feature commit `7890ac1`.
- `package-lock.json` was not reviewed; dependency reproducibility depends on it.
- There is no LICENSE file, CONTRIBUTING guide, CI workflow, issue template, or deployment configuration beyond `Procfile`; Heroku commands are documented in README.
- The declared Node engine is `22.x`, matching Heroku's supported runtime; tests were run locally on Node 24.

### Missing features / product gaps

- No server-side conversation persistence, accounts, sharing, or multi-user isolation.
- No model picker in the UI; the model is whatever the bridge/env reports.
- No token counting, cost display, attachment/vision support, or tool/function calling.
- No browser E2E tests, accessibility audit, load testing, or real tunnel integration tests.
- No Dockerfile, reverse-proxy config, healthcheck manifest, or infrastructure-as-code.
- No structured logging/metrics/tracing; only a minimal request logger and console messages.
- No CI pipeline to run `npm test`, `node --check`, or notebook freshness checks before deployment.

---

## 11. TODO LIST

### P0 — run/deploy the integration

- [x] Generate `kaggle/notebook.ipynb` from `kaggle/notebook.py`.
- [x] Add a build script and a freshness test for the generated notebook.
- [x] Update README to upload the generated notebook rather than the Python source.
- [x] Add optional `ACCESS_PASSWORD` auth with login/logout and session cookies.
- [x] Add status `source`, two-failure UI threshold, fixed status labels, stream validation, model omission, static 404, and `HOST` handling.
- [x] Add mock-upstream/security/auth/status/frontend/notebook/Heroku tests.
- [x] Add `SESSION_SECRET` support, production password warning, startup flag logging, and SSE keep-alive.
- [x] Set Node engine to `22.x` and document single-Eco-dyno Heroku deployment, H12 limits, and token matching.
- [ ] Set real `SITE_URL`, `KAGGLE_BRIDGE_TOKEN`, and (if needed) `HF_TOKEN` in Kaggle; upload `kaggle/notebook.ipynb` and run it.
- [ ] Configure the website with matching `BRIDGE_TOKEN`, a strong `ACCESS_PASSWORD`, `ALLOWED_ORIGIN`, and `TRUST_PROXY=1` if behind a trusted proxy.
- [ ] Deploy over HTTPS; verify heartbeat, status source, chat streaming, and logout end to end.

### P1 — reliability and security hardening

- [ ] Add a CI workflow that runs `npm test`, `node --check`, and notebook freshness on push.
- [ ] Add browser E2E coverage for auth, status transitions, stream stop, and persistence.
- [ ] Add token-aware conversation limits (or surface upstream context errors).
- [ ] Add persistent/shared bridge state or explicitly document single-instance operation.
- [ ] Add session revocation or shorter-lived tokens if logout must be enforceable.
- [ ] Add a formal Markdown sanitizer if raw HTML support is ever added.
- [ ] Add `npm audit`/dependency update automation and pin notebook package versions where practical.
- [ ] Add structured logging/metrics and a deployment healthcheck.

### P2 — product and repository polish

- [ ] Consolidate `test/app.test.js` onto the shared server helper.
- [ ] Add conversation export/import or server-side sync.
- [ ] Add a model selector/status details view.
- [ ] Add a LICENSE, CONTRIBUTING guide, and issue/PR templates.
- [ ] Add a Dockerfile and example reverse-proxy configuration.
- [ ] Consider automatic notebook regeneration in CI and a release checklist.

## TOTAL LINE COUNT

`PROJECT_OVERVIEW.md` has 2670 lines after this update. The count is generated automatically and may change whenever this document or the embedded source blocks are edited.
