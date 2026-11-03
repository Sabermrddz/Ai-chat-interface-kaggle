# %% [markdown]
# # Kaggle LLM bridge
#
# This notebook turns a free Kaggle GPU session into an OpenAI-compatible model
# server and publishes it through a Cloudflare quick tunnel. It then sends a
# heartbeat to your chat website so the website can find the current tunnel URL.
#
# Before running:
# 1. Enable **Internet** in the Kaggle notebook settings.
# 2. Enable a **GPU** accelerator (T4 x2 or P100 works for a 3B model).
# 3. Add a Kaggle Secret named `KAGGLE_BRIDGE_TOKEN`. Use the same long random
#    value as the website's `BRIDGE_TOKEN` environment variable.
# 4. Set `SITE_URL` below to your deployed website URL.
# 5. Run all cells and leave the final cell running.
#
# The model repo page is not an inference API. The notebook downloads the GGUF
# weights from the Hugging Face repo with `huggingface_hub` and serves them
# locally with llama-cpp-python's OpenAI-compatible server.

# %% [markdown]
# ## 1. Configuration
#
# Change these values for your model and site. The default is a small 3B model
# that fits comfortably on a free Kaggle GPU. To use a larger model, replace
# `REPO_ID` and `FILENAME` with a GGUF file that fits your GPU memory.
#
# Note: the AtomicChat/DeepSeek-V4.1-Flash GGUF repository uses multi-part
# shards that are far larger than a free Kaggle GPU can hold. If you have a
# larger GPU, point `FILENAME` at the first shard and download all shards (see
# the comments in the download cell).

# %%
REPO_ID = "bartowski/Llama-3.2-3B-Instruct-GGUF"
FILENAME = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"

MODEL_ALIAS = "llama-3.2-3b"
N_GPU_LAYERS = -1
N_CTX = 8192
CHAT_FORMAT = ""

SERVER_PORT = 8000
SITE_URL = "https://your-site.onrender.com"
HEARTBEAT_SECONDS = 30
SERVER_START_TIMEOUT_SECONDS = 1800
TUNNEL_START_TIMEOUT_SECONDS = 120

# %% [markdown]
# ## 2. Install dependencies
#
# This installs `llama-cpp-python` with its OpenAI-compatible server. A prebuilt
# CUDA wheel is tried first; if none is available, it builds from source with
# CUDA enabled. The first install can take several minutes.

# %%
import os
import shutil
import subprocess
import sys


def log(*args):
    print(*args, flush=True)


def run_command(command, **kwargs):
    log("$", " ".join(command))
    subprocess.run(command, check=True, **kwargs)


run_command(
    [sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub"]
)

wheel_indexes = [
    "https://abetlen.github.io/llama-cpp-python/whl/cu124",
    "https://abetlen.github.io/llama-cpp-python/whl/cu122",
    "https://abetlen.github.io/llama-cpp-python/whl/cu121",
]

installed_from_wheel = False
for wheel_index in wheel_indexes:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "llama-cpp-python[server]",
            "--extra-index-url",
            wheel_index,
            "--only-binary",
            "llama-cpp-python",
        ]
    )
    if result.returncode == 0:
        installed_from_wheel = True
        log(f"Installed llama-cpp-python from {wheel_index}")
        break

if not installed_from_wheel:
    log("No prebuilt CUDA wheel was found. Building llama-cpp-python from source...")
    build_env = os.environ.copy()
    build_env["CMAKE_ARGS"] = "-DGGML_CUDA=on"
    build_env["FORCE_CMAKE"] = "1"
    run_command(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "llama-cpp-python[server]",
            "--no-cache-dir",
        ],
        env=build_env,
    )

# %% [markdown]
# ## 3. Load secrets
#
# `KAGGLE_BRIDGE_TOKEN` is required. It is used as both the bearer key for the
# local OpenAI server and the shared secret for website registration. Never
# print or commit this value.
#
# `HF_TOKEN` is optional and only needed for gated Hugging Face repositories.

# %%
import os


def read_secret(name, required=False):
    try:
        from kaggle_secrets import UserSecretsClient

        value = UserSecretsClient().get_secret(name)
        if value:
            return value
    except Exception:
        pass

    value = os.environ.get(name, "")
    if required and not value:
        raise RuntimeError(
            f"Missing secret {name}. Add it in Kaggle: Add-ons > Secrets, "
            "then attach it to this notebook."
        )
    return value or None


BRIDGE_TOKEN = read_secret("KAGGLE_BRIDGE_TOKEN", required=True).strip()
HF_TOKEN = (read_secret("HF_TOKEN", required=False) or "").strip() or None

if len(BRIDGE_TOKEN) < 16:
    log("Warning: KAGGLE_BRIDGE_TOKEN is short. Use a long random value in production.")
else:
    log(f"Bridge token loaded ({len(BRIDGE_TOKEN)} characters).")

SITE_URL = (os.environ.get("SITE_URL") or SITE_URL).strip().rstrip("/")

from urllib.parse import urlparse

parsed_site = urlparse(SITE_URL)
if parsed_site.scheme not in ("http", "https") or not parsed_site.netloc:
    raise ValueError(
        "Set SITE_URL to your deployed website base URL, for example "
        "https://my-chat.onrender.com"
    )

if parsed_site.username or parsed_site.password:
    raise ValueError("SITE_URL must not contain credentials.")

if parsed_site.path not in ("", "/"):
    raise ValueError("Use the SITE_URL base only, without a path.")

if parsed_site.query or parsed_site.fragment:
    raise ValueError("SITE_URL must not contain a query or fragment.")

if "your-site" in parsed_site.netloc:
    raise ValueError("Replace the placeholder SITE_URL with your real website URL.")

if parsed_site.scheme != "https" and parsed_site.hostname not in ("localhost", "127.0.0.1"):
    raise ValueError("Use an https SITE_URL so the bridge token is not sent in plain text.")

log(f"Website: {SITE_URL}")

# %% [markdown]
# ## 4. Download the GGUF model
#
# `hf_hub_download` downloads the selected file and reuses the Hugging Face cache
# on later runs. For a split GGUF model, download every shard with
# `snapshot_download(repo_id=..., allow_patterns=[...])` and point
# `model_path` at the first shard.

# %%
from huggingface_hub import hf_hub_download

if not REPO_ID or not FILENAME:
    raise ValueError("Set REPO_ID and FILENAME at the top of the notebook.")

log(f"Downloading {REPO_ID}/{FILENAME} ...")
model_path = hf_hub_download(
    repo_id=REPO_ID,
    filename=FILENAME,
    token=HF_TOKEN,
)

model_size_gb = os.path.getsize(model_path) / (1024**3)
log(f"Model ready: {model_path} ({model_size_gb:.2f} GB)")

# %% [markdown]
# ## 5. Start the OpenAI-compatible model server
#
# The server listens on `127.0.0.1:8000` and requires the bearer token. It is not
# exposed directly; cloudflared is the only public entry point.

# %%
import time
import urllib.error
import urllib.request


def redact_command(command):
    redacted = []
    hide_next = False

    for part in command:
        if hide_next:
            redacted.append("***")
            hide_next = False
            continue
        redacted.append(part)
        if part == "--api_key":
            hide_next = True

    return " ".join(redacted)


server_command = [
    sys.executable,
    "-m",
    "llama_cpp.server",
    "--model",
    model_path,
    "--model_alias",
    MODEL_ALIAS,
    "--host",
    "127.0.0.1",
    "--port",
    str(SERVER_PORT),
    "--api_key",
    BRIDGE_TOKEN,
    "--n_gpu_layers",
    str(N_GPU_LAYERS),
    "--n_ctx",
    str(N_CTX),
]

if CHAT_FORMAT:
    server_command.extend(["--chat_format", CHAT_FORMAT])

server_log_path = "/kaggle/working/llama_server.log"
server_log = open(server_log_path, "w", buffering=1, encoding="utf-8")

log("Starting llama-cpp server:")
log(redact_command(server_command))

server_proc = subprocess.Popen(
    server_command,
    stdout=server_log,
    stderr=subprocess.STDOUT,
)


def redact_secret(text):
    if not BRIDGE_TOKEN:
        return text
    return text.replace(BRIDGE_TOKEN, "***")


def tail_server_log(lines=40):
    try:
        with open(server_log_path, "r", encoding="utf-8", errors="replace") as handle:
            content = handle.readlines()
        log(redact_secret("".join(content[-lines:])))
    except OSError:
        pass


def wait_for_model_server(timeout_seconds):
    deadline = time.time() + timeout_seconds
    last_notice = 0

    while time.time() < deadline:
        if server_proc.poll() is not None:
            tail_server_log()
            raise RuntimeError("llama-cpp server exited while loading the model.")

        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{SERVER_PORT}/v1/models",
                headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                if response.status == 200:
                    log("Model server is ready.")
                    return
        except Exception:
            pass

        now = time.time()
        if now - last_notice > 15:
            log("Waiting for the model server to finish loading...")
            last_notice = now

        time.sleep(3)

    tail_server_log()
    raise TimeoutError("The model server did not become ready in time.")


try:
    wait_for_model_server(SERVER_START_TIMEOUT_SECONDS)
except Exception:
    if server_proc.poll() is None:
        server_proc.terminate()
    raise

# %% [markdown]
# ## 6. Start the Cloudflare quick tunnel
#
# The public URL is parsed from cloudflared's output. It changes every time the
# notebook restarts, which is why the heartbeat below is important.

# %%
import re
import threading
import urllib.request

CLOUDFLARED_PATH = "/kaggle/working/cloudflared"
CLOUDFLARED_DOWNLOAD_URL = (
    "https://github.com/cloudflare/cloudflared/releases/latest/download/"
    "cloudflared-linux-amd64"
)

if not os.path.exists(CLOUDFLARED_PATH) or os.path.getsize(CLOUDFLARED_PATH) < 1_000_000:
    log("Downloading cloudflared ...")
    request = urllib.request.Request(
        CLOUDFLARED_DOWNLOAD_URL,
        headers={"User-Agent": "kaggle-llm-bridge/1.0"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        with open(CLOUDFLARED_PATH, "wb") as output:
            shutil.copyfileobj(response, output)

os.chmod(CLOUDFLARED_PATH, 0o755)
log("cloudflared is ready.")

tunnel_proc = subprocess.Popen(
    [
        CLOUDFLARED_PATH,
        "tunnel",
        "--url",
        f"http://127.0.0.1:{SERVER_PORT}",
        "--no-autoupdate",
        "--protocol",
        "http2",
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

TUNNEL_URL = None
tunnel_ready = threading.Event()
tunnel_url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def read_tunnel_output():
    global TUNNEL_URL

    if tunnel_proc.stdout is None:
        return

    for line in tunnel_proc.stdout:
        log("[cloudflared]", line.rstrip())

        if TUNNEL_URL is None:
            match = tunnel_url_pattern.search(line)
            if match:
                TUNNEL_URL = match.group(0)
                tunnel_ready.set()


tunnel_reader = threading.Thread(target=read_tunnel_output, daemon=True)
tunnel_reader.start()

try:
    if not tunnel_ready.wait(TUNNEL_START_TIMEOUT_SECONDS):
        raise RuntimeError(
            "Timed out waiting for a trycloudflare.com URL. "
            "Check the cloudflared output above."
        )
except Exception:
    if tunnel_proc.poll() is None:
        tunnel_proc.terminate()
    if server_proc.poll() is None:
        server_proc.terminate()
    raise

log(f"Public tunnel: {TUNNEL_URL}")

# %% [markdown]
# ## 7. Send heartbeats to the website
#
# Every 30 seconds the notebook POSTs `{url, model, token}` to
# `/api/bridge/register`. The website keeps this in memory and uses it to proxy
# chat requests. The browser never sees the tunnel URL or token.

# %%
import json
import time
import urllib.error
import urllib.request


stop_event = threading.Event()
heartbeat_endpoint = f"{SITE_URL}/api/bridge/register"


def heartbeat_once():
    payload = json.dumps(
        {
            "url": TUNNEL_URL,
            "model": MODEL_ALIAS,
            "token": BRIDGE_TOKEN,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        heartbeat_endpoint,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read(500).decode("utf-8", errors="replace")
            log(f"[heartbeat] HTTP {response.status}: {body}")
    except urllib.error.HTTPError as error:
        body = error.read(500).decode("utf-8", errors="replace")
        log(f"[heartbeat] HTTP {error.code}: {body}")
    except Exception as error:
        log(f"[heartbeat] failed: {type(error).__name__}: {error}")


def heartbeat_loop():
    while not stop_event.is_set():
        heartbeat_once()
        stop_event.wait(HEARTBEAT_SECONDS)


heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
heartbeat_thread.start()
log("Heartbeat started. The website should show 'Kaggle connected' shortly.")

# %% [markdown]
# ## 8. Keep the session alive and shut down cleanly
#
# Leave this cell running. Interrupting the cell (or stopping the notebook)
# terminates the model server and the tunnel.

# %%
import atexit
import signal


shutdown_started = False


def shutdown(*_args):
    global shutdown_started

    if shutdown_started:
        return
    shutdown_started = True

    log("Shutting down the Kaggle bridge...")
    stop_event.set()

    for process in (tunnel_proc, server_proc):
        if process is not None and process.poll() is None:
            process.terminate()

    for process in (tunnel_proc, server_proc):
        if process is None:
            continue
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    try:
        server_log.close()
    except Exception:
        pass

    log("Bridge stopped.")


atexit.register(shutdown)

for signal_name in ("SIGINT", "SIGTERM"):
    if hasattr(signal, signal_name):
        try:
            signal.signal(getattr(signal, signal_name), shutdown)
        except Exception:
            pass

try:
    log("Bridge is running. Leave this cell running to stay online.")
    while not stop_event.is_set():
        if server_proc.poll() is not None:
            tail_server_log()
            raise RuntimeError("The model server exited unexpectedly.")
        if tunnel_proc.poll() is not None:
            raise RuntimeError("cloudflared exited unexpectedly.")
        time.sleep(5)
except KeyboardInterrupt:
    log("Interrupted.")
finally:
    shutdown()
