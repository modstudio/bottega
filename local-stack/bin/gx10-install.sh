#!/usr/bin/env bash
# Provision the GX10 as the orchestrator's local agent.
#
#   ./gx10-install.sh            survey only, changes nothing
#   ./gx10-install.sh --go       do it
#
# Serves Qwen3.6-35B-A3B on vLLM, bound to localhost, reachable from the Mac
# over an SSH tunnel. vLLM rather than SGLang because Codex requires the
# OpenAI *Responses* API and vLLM is confirmed to serve it; SGLang is faster
# but its core server's /v1/responses support is unverified.
set -uo pipefail

GO=0; [[ "${1:-}" == "--go" ]] && GO=1
MODEL="${MODEL:-Qwen/Qwen3.6-35B-A3B-FP8}"
PORT="${PORT:-8000}"          # on the host; the client tunnels a local port here
# Why this image: orch doc show local-model-host-hardware --scope machine
IMAGE="${IMAGE:-vllm/vllm-openai:cu130-nightly}"
# Models path on this host: orch doc show local-model-host-hardware --scope machine
: "${MODELS_DIR:?set MODELS_DIR to the models directory on the host}"
# GPU_UTIL on this host: orch doc show local-model-host-hardware --scope machine
GPU_UTIL="${GPU_UTIL:-0.50}"
# The context window, and it is a ROUTING input: a job whose working set will not
# fit excludes this agent outright, so the number here decides what the local
# model is allowed to do. Keep it in step with the registered agent's
# contextTokens — `orch doctor` reads the served value back and reports a
# mismatch rather than letting the two drift.
# Why 131072 on this host: orch doc show local-model-host-hardware --scope machine
MAX_LEN="${MAX_LEN:-131072}"

ok=1
say()  { printf '%-22s %s\n' "$1" "$2"; }
fail() { printf '%-22s %s  <-- BLOCKS INSTALL\n' "$1" "$2"; ok=0; }

echo "=== survey ==="
say "host"    "$(hostname) $(uname -srm)"
say "os"      "$(cat /etc/dgx-release 2>/dev/null | head -1 || lsb_release -ds 2>/dev/null || echo unknown)"

DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
case "$DRV" in
  580.*) say "driver" "$DRV (good line)" ;;
  590.*) fail "driver" "$DRV — 590.x has a reported CUDAGraph deadlock on GB10; stay on 580.x" ;;
  "")    fail "driver" "nvidia-smi not answering" ;;
  *)     say "driver" "$DRV (unrecognized line — verify before trusting)" ;;
esac

MEM=$(free -g | awk '/^Mem:/{print $2}')
say "memory" "${MEM} GB total"
[[ "${MEM:-0}" -lt 100 ]] && fail "memory" "expected ~120 GB on GB10"

FREE=$(df -BG --output=avail "$(dirname "$MODELS_DIR")" 2>/dev/null | tail -1 | tr -dc '0-9')
say "disk" "${FREE:-?} GB free at $(dirname "$MODELS_DIR")"
[[ "${FREE:-0}" -lt 120 ]] && fail "disk" "need ~120 GB (model ~46 GB + container ~20 GB + room for a second model)"

if command -v docker >/dev/null; then
  say "docker" "$(docker --version | cut -d, -f1)"
  docker info 2>/dev/null | grep -qi nvidia && say "nvidia runtime" "present" || fail "nvidia runtime" "nvidia-container-toolkit missing"
  docker info >/dev/null 2>&1 || fail "docker perms" "cannot talk to the daemon — add yourself to the docker group"
else
  fail "docker" "not installed"
fi

grep -q nvcr.io ~/.docker/config.json 2>/dev/null \
  && say "ngc login" "present" \
  || fail "ngc login" "run: docker login nvcr.io   (username \$oauthtoken, password = NGC API key)"

if systemctl is-active --quiet ollama 2>/dev/null; then
  say "ollama" "running — will be stopped and disabled"
  systemctl cat ollama 2>/dev/null | grep -i OLLAMA_HOST | sed 's/^/                       /'
else
  say "ollama" "not running"
fi

echo
if [[ $ok -eq 0 ]]; then
  echo "Preconditions failed. Fix the lines marked above, then re-run."
  exit 1
fi
echo "Preconditions OK."
[[ $GO -eq 0 ]] && { echo "Survey only. Re-run with --go to install."; exit 0; }

echo
echo "=== 1. retire ollama ==="
# It cannot serve Codex (no /v1/responses), it does not batch, and it is
# currently bound to every interface with no authentication.
sudo systemctl stop ollama 2>/dev/null || true
sudo systemctl disable ollama 2>/dev/null || true
say "ollama" "stopped and disabled (binaries and models left in place)"

echo
echo "=== 2. pull serving container ==="
docker pull "$IMAGE" || { echo "pull failed — check the NGC login and the tag"; exit 1; }

echo
echo "=== 3. fetch model ==="
sudo mkdir -p "$MODELS_DIR" && sudo chown "$USER" "$MODELS_DIR"
if [[ -d "$MODELS_DIR/$(basename "$MODEL")" ]]; then
  say "model" "already present, skipping download"
else
  pip install -q --user huggingface_hub 2>/dev/null || true
  hf download "$MODEL" --local-dir "$MODELS_DIR/$(basename "$MODEL")" \
    || huggingface-cli download "$MODEL" --local-dir "$MODELS_DIR/$(basename "$MODEL")" \
    || { echo "download failed"; exit 1; }
fi

echo
echo "=== 4. serve ==="
docker rm -f orch-llm 2>/dev/null || true
# Published on 127.0.0.1 ONLY. The process binds 0.0.0.0 inside the container,
# but the port mapping keeps it off the LAN — reach it over an SSH tunnel.
docker run -d --name orch-llm --restart unless-stopped \
  --gpus all --ipc=host --shm-size 16g \
  -v "$MODELS_DIR:/models" \
  -p "127.0.0.1:${PORT}:8000" \
  "$IMAGE" \
  vllm serve "/models/$(basename "$MODEL")" \
    --served-model-name "$MODEL" \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization "$GPU_UTIL" \
    --max-model-len "$MAX_LEN" \
    --enable-auto-tool-choice \
    --tool-call-parser qwen3_coder \
    --reasoning-parser qwen3

echo
echo "=== 5. verify ==="
echo "First load takes 10-15 min and the first request JITs for ~25s. Waiting..."
for i in $(seq 1 90); do
  curl -sf -m 5 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1 && break
  sleep 20
  [[ $i -eq 90 ]] && { echo "did not come up in 30 min — docker logs orch-llm"; exit 1; }
done
say "/v1/models" "answering"

# The make-or-break test: Codex speaks Responses only. Chat Completions is not
# a fallback — wire_api="chat" is a hard startup error since Feb 2026.
CODE=$(curl -s -o /tmp/resp.json -w '%{http_code}' -m 30 \
  -X POST "http://127.0.0.1:${PORT}/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"input\":\"reply with the single word: ok\"}")
if [[ "$CODE" == "200" ]]; then
  say "/v1/responses" "200 — Codex could drive this too"
else
  say "/v1/responses" "HTTP $CODE — not needed; the harness is Qwen Code"
  head -c 300 /tmp/resp.json; echo
  echo "Try a newer vLLM tag from https://catalog.ngc.nvidia.com/orgs/nvidia/containers/vllm"
fi

cat <<EOF

=== done ===
On the Mac:
  ssh -N -L ${PORT}:127.0.0.1:${PORT} <host-alias> &
  export ORCH_MODEL_HOST_URL=http://127.0.0.1:${PORT}/v1
  export ORCH_MODEL_HOST_MODEL='${MODEL}'
  orch doctor
EOF
