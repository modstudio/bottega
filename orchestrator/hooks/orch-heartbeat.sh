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

ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P) || {
  echo "DEGRADED: launch directory removed; re-arm from the main checkout"
  exit 2
}
cd "$ROOT" 2>/dev/null || {
  echo "DEGRADED: launch directory removed; re-arm from the main checkout"
  exit 2
}
ORCH="$ROOT/../bin/orch"

SID="${1:?session id required (Claude session_id; orch records it on every run)}"
INTERVAL="${2:-60}"
MAX="${3:-60}"
KEEPALIVE_TICKS="${KEEPALIVE_TICKS:-15}"   # re-announce an unchanged state this often

prev_key=""
since_emit=0
reported_ids=""

for ((i = 1; i <= MAX; i++)); do
  if [ ! -d "$ROOT" ]; then
    echo "DEGRADED: launch directory removed; re-arm from the main checkout"
    exit 2
  fi
  # The heartbeat is session-scoped, not checkout-scoped. Ask for the complete
  # visible set, and make the explicit SID the identity used to derive
  # `can_answer`; the inherited environment may name a different session.
  # Query first, THEN parse. A previous version piped `orch` straight into
  # python under `set -o pipefail`; a non-zero exit from `orch` collapsed into
  # the empty fallback, which reads as "no runs" and exits CLEAR. A transient
  # orch failure would therefore announce all-clear while work was still
  # running - the precise failure this file exists to prevent. Distinguish
  # "orch said nothing" from "orch did not answer".
  inbox_raw=$(CLAUDE_CODE_SESSION_ID="$SID" "$ORCH" inbox --all --json 2>/dev/null); inbox_rc=$?
  runs_raw=$("$ORCH" runs --limit 200 --json 2>/dev/null); runs_rc=$?
  if [ ! -d "$ROOT" ]; then
    echo "DEGRADED: launch directory removed; re-arm from the main checkout"
    exit 2
  fi

  asking=$(printf '%s' "$inbox_raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if not isinstance(d, list):
    raise SystemExit(2)
if not all(isinstance(item, dict) and isinstance(item.get("can_answer"), bool) for item in d):
    raise SystemExit(2)
print(sum(item["can_answer"] for item in d))
' 2>/dev/null); inbox_parse_rc=$?

  observed=$(printf '%s' "$runs_raw" | SID="$SID" INTERVAL="$INTERVAL" python3 -c '
import sys, json, os, datetime
sid = os.environ["SID"]
now = datetime.datetime.now(datetime.timezone.utc)
recent_seconds = max(2 * float(os.environ["INTERVAL"]), 600)
out, ids, events = [], [], []
saw = False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    saw = True
    try:
        d = json.loads(line)
    except Exception:
        raise SystemExit(2)
    if not isinstance(d, dict):
        raise SystemExit(2)
    if not isinstance(d.get("id"), int) or not isinstance(d.get("job"), str):
        raise SystemExit(2)
    if not isinstance(d.get("agent"), str) or not isinstance(d.get("status"), str):
        raise SystemExit(2)
    if d.get("session_id") is not None and not isinstance(d.get("session_id"), str):
        raise SystemExit(2)
    if not isinstance(d.get("started_at"), str):
        raise SystemExit(2)
    if d.get("latency_ms") is not None and not isinstance(d.get("latency_ms"), (int, float)):
        raise SystemExit(2)
    if d.get("failure_kind") is not None and not isinstance(d.get("failure_kind"), str):
        raise SystemExit(2)
    if d.get("error") is not None and not isinstance(d.get("error"), str):
        raise SystemExit(2)
    if d.get("session_id") != sid:
        continue
    status = d.get("status")
    if status == "ok" or status in ("failed", "stale", "stopped", "abandoned"):
        timing = d
        if d.get("turns") is not None:
            if not isinstance(d["turns"], list):
                raise SystemExit(2)
            if d["turns"]:
                timing = d["turns"][-1]
                if not isinstance(timing, dict):
                    raise SystemExit(2)
                if not isinstance(timing.get("started_at"), str):
                    raise SystemExit(2)
                if timing.get("latency_ms") is not None and not isinstance(timing.get("latency_ms"), (int, float)):
                    raise SystemExit(2)
        latency = timing.get("latency_ms")
        try:
            started = datetime.datetime.fromisoformat(timing["started_at"].replace("Z", "+00:00"))
            terminal = started if latency is None else started + datetime.timedelta(milliseconds=latency)
            recent = (now - terminal).total_seconds() <= recent_seconds
        except Exception:
            raise SystemExit(2)
        if latency is None:
            duration = "?"
        elif latency < 60000:
            duration = "%.1fs" % (latency / 1000)
        else:
            seconds = round(latency / 1000)
            duration = "%dm%02ds" % (seconds // 60, seconds % 60)
        error = (d.get("error") or "").splitlines()[0] if d.get("error") else ""
        error = error.replace("\t", " ").replace("\r", " ")
        events.append((str(d["id"]), "1" if recent else "0", status, d["job"], d["agent"],
                       d.get("failure_kind") or "-", duration, error))
    # `asking` counts as live. A heartbeat that watches only `running` reports
    # CLEAR while a worker sits blocked - the exact failure this file prevents.
    if status not in ("running", "asking"):
        continue
    try:
        started = datetime.datetime.fromisoformat(d["started_at"].replace("Z", "+00:00"))
        el = int((now - started).total_seconds())
        age = "%dm%02ds" % (el // 60, el % 60)
    except Exception:
        age = "?"
    ids.append(str(d.get("id")))
    out.append("%s/%s %s %s %s" % (d.get("id"), d.get("job"), d.get("agent"), d.get("status"), age))
if not saw:
    raise SystemExit(2)
# count \t detail \t state-key (ids only - elapsed must never enter the key)
print("STATE", len(out), " | ".join(out), ",".join(sorted(ids)), sep="\t")
for event in events:
    print("EVENT", *event, sep="\t")
') ; runs_parse_rc=$?

  if [ "$inbox_rc" -ne 0 ] || [ "$runs_rc" -ne 0 ] || \
     [ "$inbox_parse_rc" -ne 0 ] || [ "$runs_parse_rc" -ne 0 ]; then
    key="degraded"
    since_emit=$((since_emit + 1))
    if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
      prev_key="$key"; since_emit=0
      echo "[$(date +%H:%M:%S)] DEGRADED - orch observation failed (inbox rc=$inbox_rc parse=$inbox_parse_rc, runs rc=$runs_rc parse=$runs_parse_rc). State unknown; NOT concluding clear."
    fi
    sleep "$INTERVAL"; continue
  fi

  asking=${asking:-0}
  state=${observed%%$'\n'*}
  state=${state#*$'\t'}
  n=${state%%$'\t'*}; rest=${state#*$'\t'}
  detail=${rest%%$'\t'*}; ids=${rest#*$'\t'}
  n=${n:-0}

  while IFS=$'\t' read -r record id recent status job agent failure_kind latency error; do
    [ "$record" = "EVENT" ] || continue
    case " $reported_ids " in
      *" $id "*) continue ;;
    esac
    reported_ids="$reported_ids $id"
    [ "$recent" = "1" ] || continue
    if [ "$status" = "ok" ]; then
      echo "FINISHED $id/$job $agent $latency"
    elif [ "$failure_kind" = "harness" ]; then
      echo "HARNESS-REFUSED $id/$job $agent $failure_kind $latency $error"
    else
      echo "FAILED $id/$job $agent $failure_kind $latency $error"
    fi
  done <<< "$observed"

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
