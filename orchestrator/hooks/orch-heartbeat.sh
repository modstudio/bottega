#!/usr/bin/env bash
#
# Report, at an interval, whether a session is waiting or is blocked.
#
# `orch do` is detach-by-default, so a session that dispatches work and then sits
# in `orch wait` emits nothing for as long as the worker runs. From outside that
# is indistinguishable from a session that has died, and the operator cannot tell
# whether it needs a wake or is genuinely waiting. That ambiguity is the whole
# reason this exists: it collapses to three states, one of which is actionable.
#
#   BLOCKED  a worker asked a question; the session must rule and resume it
#   WAITING  runs still going, elapsed shown so a hung one is visible
#   CLEAR    nothing running and nothing asked -> exits SILENTLY
#
# EMITS ONLY ON STATE CHANGE, plus a keepalive every KEEPALIVE_TICKS.
#
# This matters more than it looks. Under the Monitor tool every emitted line
# wakes the model for a turn, so a line repeating "still waiting, nothing needed"
# costs a full invocation to say nothing. Measured 2026-09-04: a 120s interval
# across a 6-minute wait produced three identical WAITING events and three wasted
# turns. State-change emission is what makes the interval cheap enough to lower,
# and a lower interval is what actually gets a blocked worker noticed sooner -
# the poll can be frequent precisely because only transitions are expensive.
#
# The state key is (asking-count, run-count, sorted run ids). A run finishing or
# a new question arriving changes it; time passing does not.
#
# CLEAR is silent so this stays cheap to run often: the answer to "should this
# session still be waiting" is only worth a notification when it is yes, or when
# it needs something. Exit 0 with no output is the "nothing to say" answer, and
# the Monitor tool reports the exit itself.
#
# This is deliberately SESSION-SCOPED. Machine-wide operational state - runs
# stuck asking whose session has gone, dead-process runs, orphan worktrees,
# unscored runs - is `orch monitor` (DEV-198), which answers a different
# question for a different consumer. Do not grow this into that.
#
# Usage:  orch-heartbeat.sh <session-id> [interval-seconds] [max-ticks]
# Arm it under the Monitor tool; each emitted line becomes one notification.
set -uo pipefail

SID="${1:?session id required (Claude session_id; orch records it on every run)}"
INTERVAL="${2:-60}"
MAX="${3:-60}"
KEEPALIVE_TICKS="${KEEPALIVE_TICKS:-15}"   # re-announce an unchanged state this often

prev_key=""
since_emit=0

for ((i = 1; i <= MAX; i++)); do
  # The heartbeat is session-scoped, not checkout-scoped. Ask for the complete
  # visible set, and make the explicit SID the identity used to derive
  # `can_answer`; the inherited environment may name a different session.
  # Query first, THEN parse. A previous version piped `orch` straight into
  # python under `set -o pipefail`; a non-zero exit from `orch` collapsed into
  # the empty fallback, which reads as "no runs" and exits CLEAR. A transient
  # orch failure would therefore announce all-clear while work was still
  # running - the precise failure this file exists to prevent. Distinguish
  # "orch said nothing" from "orch did not answer".
  inbox_raw=$(CLAUDE_CODE_SESSION_ID="$SID" orch inbox --all --json 2>/dev/null); inbox_rc=$?
  runs_raw=$(orch runs --limit 200 --json 2>/dev/null); runs_rc=$?

  if [ "$inbox_rc" -ne 0 ] || [ "$runs_rc" -ne 0 ]; then
    key="degraded"
    since_emit=$((since_emit + 1))
    if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
      prev_key="$key"; since_emit=0
      echo "[$(date +%H:%M:%S)] DEGRADED - orch did not answer (inbox rc=$inbox_rc, runs rc=$runs_rc). State unknown; NOT concluding clear."
    fi
    sleep "$INTERVAL"; continue
  fi

  asking=$(printf '%s' "$inbox_raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
rows = d if isinstance(d, list) else d.get("questions", d.get("items", []))
print(sum(bool(item.get("can_answer")) for item in rows if isinstance(item, dict)))
' 2>/dev/null) || asking=0
  asking=${asking:-0}

  live=$(printf '%s' "$runs_raw" | SID="$SID" python3 -c '
import sys, json, os, datetime
sid = os.environ["SID"]
now = datetime.datetime.now(datetime.timezone.utc)
out, ids = [], []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    # `asking` counts as live. A heartbeat that watches only `running` reports
    # CLEAR while a worker sits blocked - the exact failure this file prevents.
    if d.get("session_id") != sid or d.get("status") not in ("running", "asking"):
        continue
    try:
        started = datetime.datetime.fromisoformat(d["started_at"].replace("Z", "+00:00"))
        el = int((now - started).total_seconds())
        age = "%dm%02ds" % (el // 60, el % 60)
    except Exception:
        age = "?"
    ids.append(str(d.get("id")))
    out.append("%s/%s %s %s %s" % (d.get("id"), d.get("job"), d.get("agent"), d.get("status"), age))
# count \t detail \t state-key (ids only - elapsed must never enter the key)
print(len(out), " | ".join(out), ",".join(sorted(ids)), sep="\t")
') || live=$'0\t\t'
  n=${live%%$'\t'*}; rest=${live#*$'\t'}
  detail=${rest%%$'\t'*}; ids=${rest#*$'\t'}
  n=${n:-0}

  key="$asking|$n|$ids"
  since_emit=$((since_emit + 1))
  if [ "$key" = "$prev_key" ] && [ "$since_emit" -lt "$KEEPALIVE_TICKS" ]; then
    sleep "$INTERVAL"; continue
  fi
  prev_key="$key"; since_emit=0

  ts=$(date +%H:%M:%S)
  if [ "$asking" -gt 0 ]; then
    echo "[$ts] BLOCKED - $asking question(s) waiting on you: run 'orch inbox', then 'orch answer <id>'. $n run(s) live."
  elif [ "$n" -gt 0 ]; then
    echo "[$ts] WAITING - $n run(s), nothing needed from you: $detail"
  else
    exit 0
  fi
  sleep "$INTERVAL"
done

# Bounded on purpose: an unbounded poll against a service whose failure mode is
# "never satisfied" is the loop this codebase's rules forbid.
echo "[$(date +%H:%M:%S)] HEARTBEAT ENDED - $MAX ticks elapsed; re-arm if still waiting."
