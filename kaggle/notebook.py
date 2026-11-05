# %% [markdown]
# # Kaggle LLM Bridge (compact)
# Before running: enable **Internet** + **GPU**, add Secret `KAGGLE_BRIDGE_TOKEN`
# (same value as Heroku `BRIDGE_TOKEN`) and attach it to this notebook.
# Run the 3 cells in order and leave the last one running.

# %%
# ===== 1. CONFIG + SECRETS + INSTALL =====
SITE_URL = "https://ai-interface-c8ee903485e4.herokuapp.com"
REPO_ID = "bartowski/Llama-3.2-3B-Instruct-GGUF"
FILENAME = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
ALIAS = "llama-3.2-3b"
N_CTX = 8192
PORT = 8000

import os, sys, subprocess, time, json, re, threading
import urllib.request, urllib.error
from kaggle_secrets import UserSecretsClient

secrets = UserSecretsClient()
TOKEN = secrets.get_secret("KAGGLE_BRIDGE_TOKEN").strip()
try:
    HF_TOKEN = secrets.get_secret("HF_TOKEN") or None
except Exception:
    HF_TOKEN = None

pip = [sys.executable, "-m", "pip", "install", "-q"]
subprocess.run(pip + ["-U", "huggingface_hub"], check=True)
for cu in ("cu124", "cu122", "cu121"):  # try prebuilt CUDA wheels first
    r = subprocess.run(pip + [
        "llama-cpp-python[server]", "--only-binary", "llama-cpp-python",
        "--extra-index-url", f"https://abetlen.github.io/llama-cpp-python/whl/{cu}",
    ])
    if r.returncode == 0:
        break
else:  # fallback: build from source (slow)
    env = {**os.environ, "CMAKE_ARGS": "-DGGML_CUDA=on", "FORCE_CMAKE": "1"}
    subprocess.run(pip + ["llama-cpp-python[server]", "--no-cache-dir"], check=True, env=env)
print("Setup done.")

# %%
import subprocess, sys, os, glob, site

subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                "nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"], check=True)

libs = []
for sp in site.getsitepackages() + [site.getusersitepackages()]:
    libs += glob.glob(os.path.join(sp, "nvidia", "*", "lib"))

os.environ["LD_LIBRARY_PATH"] = ":".join(libs + [os.environ.get("LD_LIBRARY_PATH", "")])
print("CUDA lib dirs:", libs)

subprocess.run(["nvidia-smi", "-L"])
subprocess.run([sys.executable, "-c",
                "import llama_cpp; print('llama_cpp OK', llama_cpp.__version__)"])

# %%
# ===== 2. DOWNLOAD MODEL + START SERVER =====
from huggingface_hub import hf_hub_download

model = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, token=HF_TOKEN)
log_path = "/kaggle/working/server.log"
server = subprocess.Popen(
    [sys.executable, "-m", "llama_cpp.server", "--model", model, "--model_alias", ALIAS,
     "--host", "127.0.0.1", "--port", str(PORT), "--api_key", TOKEN,
     "--n_gpu_layers", "-1", "--n_ctx", str(N_CTX)],
    stdout=open(log_path, "w", buffering=1), stderr=subprocess.STDOUT,
)

def server_ready():
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/models",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
        return urllib.request.urlopen(req, timeout=5).status == 200
    except Exception:
        return False

for _ in range(600):
    if server.poll() is not None:
        print(open(log_path).read()[-2000:].replace(TOKEN, "***"))
        raise RuntimeError("Model server crashed (see log above).")
    if server_ready():
        break
    time.sleep(3)
else:
    raise TimeoutError("Model server did not start in time.")
print("Model server ready.")

# %%
# ===== 3. TUNNEL + HEARTBEAT (leave running) =====
CF = "/kaggle/working/cloudflared"
if not os.path.exists(CF):
    urllib.request.urlretrieve(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", CF)
os.chmod(CF, 0o755)

tunnel = subprocess.Popen(
    [CF, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate", "--protocol", "http2"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
)
found = []

def drain():  # keeps the pipe empty and captures the public URL
    for line in tunnel.stdout:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m and not found:
            found.append(m.group(0))

threading.Thread(target=drain, daemon=True).start()
for _ in range(120):
    if found:
        break
    time.sleep(1)
else:
    raise RuntimeError("No trycloudflare.com URL received.")
URL = found[0]
print("Public tunnel:", URL)

def beat():
    body = json.dumps({"url": URL, "model": ALIAS, "token": TOKEN}).encode()
    req = urllib.request.Request(f"{SITE_URL}/api/bridge/register", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
        return "ok"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read(200).decode(errors='replace')}"
    except Exception as e:
        return f"failed: {e}"

try:
    first = True
    while server.poll() is None and tunnel.poll() is None:
        result = beat()
        if first or result != "ok":
            print("[heartbeat]", result)
            first = False
        time.sleep(30)
    print("A process exited; stopping.")
finally:
    for p in (tunnel, server):
        if p.poll() is None:
            p.terminate()
