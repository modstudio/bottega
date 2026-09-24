#!/usr/bin/env bash
#
# Report, at an interval, whether a session is waiting or is blocked.
#
# `orch do` is detach-by-default, so a session that dispatches work and then sits
# in `orch wait` emits nothing for as long as the worker runs. From outside that
# is indistinguishable from a session that has died, and the operator cannot tell
# whether it needs a wake or is genuinely waiting. That ambiguity is the whole
# reason this exists: it collapses to four states, two of which are actionable.
#
#   BLOCKED  a worker asked a question; the session must rule and resume it
#   STALLED  a worker is silent and using no CPU; stop and re-dispatch or wait
#   WAITING  runs or landings still going, elapsed shown so a hung one is visible
#   CLEAR    no runs, no landings, and nothing asked -> exits SILENTLY
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
# The state key is (asking-count, run-count, sorted run ids with each run's
# liveness class, landing-count, sorted landing ids). A run changing liveness
# class is a state change even when the ids are unchanged. Elapsed time never
# enters the key.
#
# CLEAR is silent so this stays cheap to run often: the answer to "should this
# session still be waiting" is only worth a notification when it is yes, or when
# it needs something. Exit 0 with no output is the "nothing to say" answer, and
# the Monitor tool reports the exit itself.
#
# Detection remains deliberately machine-wide in `orch monitor`.
# This hook also classifies stalled runs from the canonical run listing so the
# owning session learns promptly; supplemental monitor notices remain below.
# Conditions without an owner stay in the monitor report for the fixer queue.
#
# Usage:  orch-heartbeat.sh <session-id> [interval-seconds] [max-ticks]
# Arm it under the Monitor tool; each emitted line becomes one notification.
set -uo pipefail

CALLER_DIRECTORY="$PWD"
ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P) || {
  echo "DEGRADED: launch directory removed; re-arm from the main checkout"
  exit 2
}
cd "$ROOT" 2>/dev/null || {
  echo "DEGRADED: launch directory removed; re-arm from the main checkout"
  exit 2
}
ORCH="$ROOT/../bin/orch"
if [ -n "${ORCH_DB:-}" ]; then
  case "$ORCH_DB" in
    /*) DB_PATH="$ORCH_DB" ;;
    *) DB_PATH="$CALLER_DIRECTORY/$ORCH_DB" ;;
  esac
else
  DB_PATH=$(bun --no-env-file "$ROOT/../shared/state-directory.ts" orchestrator database) || {
    echo "DEGRADED: cannot resolve orchestrator database"
    exit 2
  }
fi
export ORCH_DB="$DB_PATH"

SID="${1:?session id required (Claude session_id; orch records it on every run)}"
INTERVAL="${2:-60}"
MAX="${3:-60}"
KEEPALIVE_TICKS="${KEEPALIVE_TICKS:-15}"   # re-announce an unchanged state this often
NOTICE_TIMEOUT_SECONDS="${NOTICE_TIMEOUT_SECONDS:-5}"

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
  inbox_err=$(mktemp)
  runs_err=$(mktemp)
  inbox_raw=$(CLAUDE_CODE_SESSION_ID="$SID" "$ORCH" inbox --all --json 2>"$inbox_err"); inbox_rc=$?
  runs_raw=$("$ORCH" runs --limit 200 --json 2>"$runs_err"); runs_rc=$?
  rm -f "$inbox_err" "$runs_err"
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
out, ids, events, stalled, stalled_subjects = [], [], [], [], []
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
    if "schema_version" in d:
        d = d.get("data")
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
        events.append((str(d["id"]), "1" if recent else "0", status, d["job"], d["agent"],
                       d.get("failure_kind") or "-", duration))
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
    idle = d.get("idle")
    idle_note = ""
    if isinstance(idle, str) and idle.startswith("idle "):
        idle_note = " " + idle
    stall_state = d.get("stall_state")
    if status == "running" and stall_state not in ("healthy", "stalled", "unknown"):
        raise SystemExit(2)
    stall = d.get("stall")
    if stall_state == "stalled":
        if not isinstance(stall, str) or not stall:
            raise SystemExit(2)
        stalled.append(stall.replace("\t", " ").replace("\r", " ").replace("\n", " "))
        member_id = d.get("live_member_id")
        if not isinstance(member_id, int):
            raise SystemExit(2)
        stalled_subjects.append("run:" + str(member_id))
    ids.append(str(d.get("id")) + ("s" if stall_state == "stalled" else ("i" if idle_note else "")))
    out.append("%s/%s %s %s %s%s" % (d.get("id"), d.get("job"), d.get("agent"), d.get("status"), age, idle_note))
if not saw:
    raise SystemExit(2)
# count \t detail \t state-key (ids only - elapsed must never enter the key)
print("STATE", len(out), " | ".join(out), ",".join(sorted(ids)), len(stalled),
      ",".join(sorted(stalled_subjects)), " | ".join(stalled), sep="\t")
for event in events:
    print("EVENT", *event, sep="\t")
') ; runs_parse_rc=$?

  # A landing is deliberately not a run, but it is live work owned by the same
  # session. Read only the small session slice directly from the store; this is
  # part of health computation and therefore remains ahead of all supplemental
  # monitor-notice work.
  landings_observed=$(SID="$SID" ORCH_DB_PATH="$DB_PATH" python3 -c '
import datetime, json, os, sqlite3, sys
path = os.environ["ORCH_DB_PATH"]
if not os.path.exists(path):
    print("STATE", 0, "", "", sep="\t")
    raise SystemExit(0)
try:
    connection = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=2)
    rows = connection.execute(
        "SELECT id, branch, status, started_at, finished_at FROM landing "
        "WHERE session_id = ? AND status IN (\"queued\",\"running\") ORDER BY id",
        (os.environ["SID"],),
    ).fetchall()
finally:
    try:
        connection.close()
    except Exception:
        pass
now = datetime.datetime.now(datetime.timezone.utc)
live, ids = [], []
for landing_id, branch, status, started_at, finished_at in rows:
    if not isinstance(landing_id, int) or not all(isinstance(v, str) for v in (branch, status, started_at)):
        raise SystemExit(2)
    branch = branch.replace("\t", " ").replace("\r", " ").replace("\n", " ")
    try:
        started = datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except Exception:
        raise SystemExit(2)
    if status in ("queued", "running"):
        elapsed = max(0, int((now - started).total_seconds()))
        age = "%dm%02ds" % (elapsed // 60, elapsed % 60)
        ids.append(str(landing_id))
        live.append("%s/%s %s %s" % (landing_id, branch, status, age))
print("STATE", len(live), " | ".join(live), ",".join(ids), sep="\t")
' 2>/dev/null); landings_parse_rc=$?

  if [ "$inbox_rc" -ne 0 ] || [ "$runs_rc" -ne 0 ] || \
     [ "$inbox_parse_rc" -ne 0 ] || [ "$runs_parse_rc" -ne 0 ] || \
     [ "$landings_parse_rc" -ne 0 ]; then
    key="degraded"
    since_emit=$((since_emit + 1))
    if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
      prev_key="$key"; since_emit=0
      echo "[$(date +%H:%M:%S)] DEGRADED - orch observation failed (inbox rc=$inbox_rc parse=$inbox_parse_rc, runs rc=$runs_rc parse=$runs_parse_rc, landings parse=$landings_parse_rc). State unknown; NOT concluding clear. Inspect orch diagnostics directly."
    fi
    sleep "$INTERVAL"; continue
  fi

  asking=${asking:-0}
  state=${observed%%$'\n'*}
  state=${state#*$'\t'}
  n=${state%%$'\t'*}; rest=${state#*$'\t'}
  detail=${rest%%$'\t'*}; rest=${rest#*$'\t'}
  ids=${rest%%$'\t'*}; rest=${rest#*$'\t'}
  stalled_n=${rest%%$'\t'*}; rest=${rest#*$'\t'}
  stalled_subjects=${rest%%$'\t'*}; stalled_detail=${rest#*$'\t'}
  n=${n:-0}
  stalled_n=${stalled_n:-0}
  landing_state=${landings_observed%%$'\n'*}
  landing_state=${landing_state#*$'\t'}
  landing_n=${landing_state%%$'\t'*}; landing_rest=${landing_state#*$'\t'}
  landing_detail=${landing_rest%%$'\t'*}; landing_ids=${landing_rest#*$'\t'}
  landing_n=${landing_n:-0}

  while IFS=$'\t' read -r record id recent status job agent failure_kind latency; do
    [ "$record" = "EVENT" ] || continue
    case " $reported_ids " in
      *" $id "*) continue ;;
    esac
    reported_ids="$reported_ids $id"
    [ "$recent" = "1" ] || continue
    if [ "$status" = "ok" ]; then
      echo "FINISHED $id/$job $agent $latency"
    elif [ "$failure_kind" = "harness" ]; then
      echo "HARNESS-REFUSED $id/$job $agent $failure_kind $latency; inspect with 'orch run $id'"
    else
      echo "FAILED $id/$job $agent $failure_kind $latency; inspect with 'orch run $id'"
    fi
  done <<< "$observed"

  key="$asking|$n|$ids|$landing_n|$landing_ids"
  since_emit=$((since_emit + 1))
  should_exit=0
  direct_stalled_subjects=""
  if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
    prev_key="$key"; since_emit=0
    ts=$(date +%H:%M:%S)
    if [ "$asking" -gt 0 ]; then
      echo "[$ts] BLOCKED - $asking question(s) waiting on you: run 'orch inbox', then 'orch answer <id>'. $n run(s) and $landing_n landing(s) live."
    fi
    if [ "$stalled_n" -gt 0 ]; then
      echo "[$ts] STALLED - $stalled_n run(s): $stalled_detail"
      direct_stalled_subjects="$stalled_subjects"
    elif [ "$asking" -eq 0 ] && { [ "$n" -gt 0 ] || [ "$landing_n" -gt 0 ]; }; then
      combined_detail="$detail"
      if [ -n "$landing_detail" ]; then
        [ -z "$combined_detail" ] || combined_detail="$combined_detail | "
        combined_detail="$combined_detail$landing_detail"
      fi
      echo "[$ts] WAITING - $n run(s) and $landing_n landing(s), nothing needed from you: $combined_detail"
    elif [ "$asking" -eq 0 ]; then
      should_exit=1
    fi
  elif [ "$asking" -eq 0 ] && [ "$n" -eq 0 ] && [ "$landing_n" -eq 0 ]; then
    should_exit=1
  fi

  # Health above is complete and, when actionable, already on stdout. Only now
  # may supplemental notice work begin; neither a fetch nor an acknowledgement
  # can suppress BLOCKED/WAITING/CLEAR for this tick.
  monitor_err=$(mktemp)
  monitor_out=$(mktemp)
  monitor_timed_out=$(mktemp)
  CLAUDE_CODE_SESSION_ID="$SID" "$ORCH" monitor --notices --json >"$monitor_out" 2>"$monitor_err" &
  monitor_pid=$!
  (
    sleep "$NOTICE_TIMEOUT_SECONDS"
    if kill -0 "$monitor_pid" 2>/dev/null; then
      printf 'timed-out\n' >"$monitor_timed_out"
      kill "$monitor_pid" 2>/dev/null || true
    fi
  ) &
  monitor_watchdog=$!
  wait "$monitor_pid"; monitor_rc=$?
  kill "$monitor_watchdog" 2>/dev/null || true
  wait "$monitor_watchdog" 2>/dev/null || true
  monitor_raw=$(<"$monitor_out")
  if [ -s "$monitor_timed_out" ]; then monitor_rc=124; fi
  rm -f "$monitor_err" "$monitor_out" "$monitor_timed_out"

  monitor_observed=$(printf '%s' "$monitor_raw" | SID="$SID" STALLED_SUBJECTS="$direct_stalled_subjects" python3 -c '
import sys, json, os
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if not isinstance(rows, list):
    raise SystemExit(2)
for row in rows:
    if not isinstance(row, dict) or not isinstance(row.get("noticeId"), str):
        raise SystemExit(2)
    source, separator, identifier = row["noticeId"].partition(":")
    if source not in ("condition", "landing") or separator != ":" or not identifier.isdigit() or int(identifier) < 1:
        raise SystemExit(2)
    if not all(isinstance(row.get(key), str) for key in ("kind", "subject", "detail")):
        raise SystemExit(2)
    if row.get("ownerSession") != os.environ["SID"]:
        raise SystemExit(2)
    values = [row[key].replace("\t", " ").replace("\r", " ").replace("\n", " ")
              for key in ("kind", "subject", "detail")]
    directly_reported = set(filter(None, os.environ["STALLED_SUBJECTS"].split(",")))
    message = "" if values[0] == "stalled-run" and values[1] in directly_reported else (values[2] if values[0].startswith("landing-") else (
        "MONITOR " + values[0] + " " + values[1] + ": " + values[2]
    ))
    print(str(row["noticeId"]) + "\t" + message)
' 2>/dev/null); monitor_parse_rc=$?

  if [ "$monitor_rc" -ne 0 ] || [ "$monitor_parse_rc" -ne 0 ]; then
    echo "[$(date +%H:%M:%S)] DEGRADED - monitor notices unavailable (rc=$monitor_rc parse=$monitor_parse_rc). Health state still follows inbox and runs; inspect monitor diagnostics directly."
  elif [ -n "$monitor_observed" ]; then
    monitor_ids=$(printf '%s\n' "$monitor_observed" | cut -f1 | paste -sd, -)
    CAP_DIR=""
    CAP_DIR=$(mktemp -d 2>/dev/null); cap_mint_rc=$?
    if [ "$cap_mint_rc" -eq 0 ]; then
      CAP_PATH="$CAP_DIR/capability.json"
      CAP_TOKEN=$(python3 -c '
import json, os, secrets, sys
token = secrets.token_hex(32)
with open(sys.argv[1], "x", encoding="utf-8") as f:
    os.chmod(sys.argv[1], 0o600)
    json.dump({"token": token, "pid": int(sys.argv[2])}, f)
print(token)
' "$CAP_PATH" "$$" 2>/dev/null); cap_mint_rc=$?
    fi
    if [ "$cap_mint_rc" -ne 0 ]; then
      [ -z "${CAP_DIR:-}" ] || rm -rf "$CAP_DIR"
      echo "[$(date +%H:%M:%S)] DEGRADED - monitor notice delivery capability unavailable. Health state still follows inbox and runs."
    elif printf '%s\n' "$monitor_observed" | cut -f2- | awk 'length > 0'; then
      export ORCH_MONITOR_CAPABILITY_PATH="$CAP_PATH"
      export ORCH_MONITOR_CAPABILITY_TOKEN="$CAP_TOKEN"
      ack_timed_out=$(mktemp)
      CLAUDE_CODE_SESSION_ID="$SID" "$ORCH" monitor --ack-notices "$monitor_ids" >/dev/null 2>&1 &
      ack_pid=$!
      (
        sleep "$NOTICE_TIMEOUT_SECONDS"
        if kill -0 "$ack_pid" 2>/dev/null; then
          printf 'timed-out\n' >"$ack_timed_out"
          kill "$ack_pid" 2>/dev/null || true
        fi
      ) &
      ack_watchdog=$!
      wait "$ack_pid"; ack_rc=$?
      kill "$ack_watchdog" 2>/dev/null || true
      wait "$ack_watchdog" 2>/dev/null || true
      if [ -s "$ack_timed_out" ]; then ack_rc=124; fi
      rm -f "$ack_timed_out"
      rm -rf "$CAP_DIR"
      unset ORCH_MONITOR_CAPABILITY_PATH ORCH_MONITOR_CAPABILITY_TOKEN
      if [ "$ack_rc" -ne 0 ]; then
        echo "[$(date +%H:%M:%S)] DEGRADED - monitor notice acknowledgement failed; delivered notices may repeat. Health state still follows inbox and runs."
      fi
    fi
  fi

  if [ "$should_exit" -eq 1 ]; then
    exit 0
  else
    sleep "$INTERVAL"
  fi
done

# Bounded on purpose: an unbounded poll against a service whose failure mode is
# "never satisfied" is the loop this codebase's rules forbid.
echo "[$(date +%H:%M:%S)] HEARTBEAT ENDED - $MAX ticks elapsed; re-arm if still waiting."
