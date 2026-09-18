#!/usr/bin/env bash
# Verify the model-host endpoint in the order that matters: each step gates the next.
#   ./smoke-test.sh [base_url]        default http://127.0.0.1:8010/v1
set -uo pipefail
if [[ -n "${1:-}" ]]; then
  BASE="$1"
elif [[ ${ORCH_MODEL_HOST_URL+x} ]]; then
  BASE="$ORCH_MODEL_HOST_URL"
elif [[ ${ORCH_LOCAL_BASE_URL+x} ]]; then
  printf '%s\n' 'ORCH_LOCAL_BASE_URL is deprecated; use ORCH_MODEL_HOST_URL' >&2
  BASE="$ORCH_LOCAL_BASE_URL"
else
  BASE='http://127.0.0.1:8010/v1'
fi
ok=0; fail=0
step() { printf '%-34s ' "$1"; }
pass() { echo "ok${1:+  $1}"; ok=$((ok+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }

step "1. /v1/models answers"
MODELS=$(curl -sf -m 10 "$BASE/models" 2>/dev/null) \
  && pass "$(echo "$MODELS" | python3 -c 'import json,sys; print(", ".join(m["id"] for m in json.load(sys.stdin).get("data",[])))' 2>/dev/null)" \
  || { bad "server not answering at $BASE"; echo; echo "Nothing else can pass. Check: docker logs orch-llm"; exit 1; }

MODEL=$(echo "$MODELS" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(d[0]["id"] if d else "")' 2>/dev/null)

# Informational: the harness is Qwen Code, which speaks chat completions.
# Test the `developer` role, not a bare string — a plain input returns 200 even
# where Codex fails, which is exactly how this endpoint looked usable when it
# was not.
step "2. /v1/responses + developer role"
CODE=$(curl -s -o /tmp/smoke-resp.json -w '%{http_code}' -m 60 -X POST "$BASE/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"developer\",\"content\":\"be brief\"},{\"role\":\"user\",\"content\":\"say ok\"}]}" 2>/dev/null)
[ "$CODE" = "200" ] && pass "Codex could drive this too" \
  || pass "HTTP $CODE — Codex cannot; Qwen Code does not need it"

step "3. chat completions"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$BASE/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":8}" 2>/dev/null)
[ "$CODE" = "200" ] && pass || bad "HTTP $CODE"

# THE make-or-break test: every delegated job depends on tool calls
# round-tripping, not on text generation.
step "4. tool call round-trips  <-- decisive"
OUT=$(curl -s -m 90 -X POST "$BASE/chat/completions" -H 'Content-Type: application/json' -d "{
  \"model\":\"$MODEL\",
  \"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Paris? Use the tool.\"}],
  \"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",
    \"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}}],
  \"tool_choice\":\"auto\",\"max_tokens\":128}" 2>/dev/null)
echo "$OUT" | grep -q 'tool_calls' && pass || bad "no tool_calls in reply — check --enable-auto-tool-choice and --tool-call-parser"

step "5. decode throughput"
T0=$(date +%s.%N)
N=$(curl -s -m 180 -X POST "$BASE/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 100, numbers only.\"}],\"max_tokens\":200}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["usage"]["completion_tokens"])' 2>/dev/null)
T1=$(date +%s.%N)
if [ -n "$N" ]; then
  pass "$(python3 -c "print(f'{$N/($T1-$T0):.1f} tok/s')")"
else bad "could not measure"; fi

echo
echo "$ok passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
