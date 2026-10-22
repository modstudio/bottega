#!/usr/bin/env bash
#
# Report, at an interval, whether a session is waiting or is blocked.
#
# `bottega run start` is detach-by-default, so a session that dispatches work and then sits
# in `bottega run wait` emits nothing for as long as the worker runs. From outside that
# is indistinguishable from a session that has died, and the operator cannot tell
# whether it needs a wake or is genuinely waiting. That ambiguity is the whole
# reason this exists: it collapses to four states, two of which are actionable.
#
#   BLOCKED  a worker asked a question; the session must rule and resume it
#   STALLED  a worker is silent and using no CPU; stop and re-dispatch or wait
#   WAITING  runs or landings still going, elapsed shown so a hung one is visible
#   CLEAR    no runs, no landings, nothing asked, and nothing stalled -> exits SILENTLY
#
# heartbeat-decision.py exits with HEARTBEAT_KEEP_LOOP_EXIT_STATUS while this
# hook should keep watching and HEARTBEAT_CLEAR_EXIT_STATUS only for CLEAR.
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
# Detection remains deliberately machine-wide in `bottega machine monitor`.
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
BOTTEGA="$ROOT/../bin/bottega"
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

SID="${1:?session id required (Claude session_id; bottega records it on every run)}"
INTERVAL="${2:-60}"
MAX="${3:-60}"
KEEPALIVE_TICKS="${KEEPALIVE_TICKS:-15}"   # re-announce an unchanged state this often
NOTICE_TIMEOUT_SECONDS="${NOTICE_TIMEOUT_SECONDS:-5}"
HEARTBEAT_KEEP_LOOP_EXIT_STATUS=0
HEARTBEAT_CLEAR_EXIT_STATUS=10

prev_key=""
since_emit=0
prev_monitor_failure_key=""
monitor_failure_ticks=0
prev_cap_failure_state=""
cap_failure_ticks=0
prev_ack_failure_state=""
ack_failure_ticks=0
reported_ids=""
previous_live_roots=""
ACTIVE_GUARDED_PID=""
ACTIVE_WATCHDOG_PID=""

start_watchdog() {
  local watchdog_target_pid="$1"
  local watchdog_marker="$2"
  (
    watchdog_sleep_pid=""
    trap '
      if [ -n "$watchdog_sleep_pid" ]; then
        kill "$watchdog_sleep_pid" 2>/dev/null || true
        wait "$watchdog_sleep_pid" 2>/dev/null || true
      fi
      exit 0
    ' TERM INT
    sleep "$NOTICE_TIMEOUT_SECONDS" &
    watchdog_sleep_pid=$!
    wait "$watchdog_sleep_pid" 2>/dev/null || exit 0
    if kill -0 "$watchdog_target_pid" 2>/dev/null; then
      printf 'timed-out\n' >"$watchdog_marker"
      kill "$watchdog_target_pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  WATCHDOG_PID=$!
}

cancel_watchdog() {
  kill "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}

cleanup_active_guarded_call() {
  if [ -n "$ACTIVE_WATCHDOG_PID" ]; then
    cancel_watchdog "$ACTIVE_WATCHDOG_PID"
    ACTIVE_WATCHDOG_PID=""
  fi
  if [ -n "$ACTIVE_GUARDED_PID" ]; then
    kill "$ACTIVE_GUARDED_PID" 2>/dev/null || true
    wait "$ACTIVE_GUARDED_PID" 2>/dev/null || true
    ACTIVE_GUARDED_PID=""
  fi
}

exit_for_signal() {
  local status="$1"
  trap - TERM INT
  cleanup_active_guarded_call
  exit "$status"
}

trap 'exit_for_signal 143' TERM
trap 'exit_for_signal 130' INT
trap cleanup_active_guarded_call EXIT

report_store_write_lock() {
  lock_out=$(mktemp)
  lock_timed_out=$(mktemp)
  CLAUDE_CODE_SESSION_ID="$SID" "$BOTTEGA" machine monitor --lock-holder --json >"$lock_out" 2>/dev/null &
  ACTIVE_GUARDED_PID=$!
  start_watchdog "$ACTIVE_GUARDED_PID" "$lock_timed_out"
  ACTIVE_WATCHDOG_PID=$WATCHDOG_PID
  wait "$ACTIVE_GUARDED_PID"; lock_rc=$?
  ACTIVE_GUARDED_PID=""
  cancel_watchdog "$ACTIVE_WATCHDOG_PID"
  ACTIVE_WATCHDOG_PID=""
  if [ -s "$lock_timed_out" ]; then lock_rc=124; fi
  if [ "$lock_rc" -eq 0 ]; then
    python3 -c '
import json, sys
try:
    report = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if report.get("classification") not in ("held", "contended") or not isinstance(report.get("pid"), int):
    raise SystemExit(0)
command = report.get("command") if isinstance(report.get("command"), str) else "unavailable"
command = command.replace("\t", " ").replace("\r", " ").replace("\n", " ")
run_id = report.get("runId")
run = str(run_id) if isinstance(run_id, int) else "none"
print("[%s] STORE WRITE LOCK - %s; pid %s; command %s; run %s" %
      (__import__("datetime").datetime.now().strftime("%H:%M:%S"), report["classification"], report["pid"], command, run))
' <"$lock_out"
  fi
  rm -f "$lock_out" "$lock_timed_out"
}

for ((i = 1; i <= MAX; i++)); do
  if [ ! -d "$ROOT" ]; then
    echo "DEGRADED: launch directory removed; re-arm from the main checkout"
    exit 2
  fi
  (cd "$CALLER_DIRECTORY" && CLAUDE_CODE_SESSION_ID="$SID" "$BOTTEGA" board presence) >/dev/null 2>&1 || true
  # The heartbeat is session-scoped, not checkout-scoped. Ask for the complete
  # visible set, and make the explicit SID the identity used to derive
  # `can_answer`; the inherited environment may name a different session.
  # Query first, THEN parse. Piping `bottega` straight into python under
  # `set -o pipefail` lets a non-zero exit collapse into
  # the empty fallback, which reads as "no runs" and exits CLEAR. A transient
  # command failure would therefore announce all-clear while work was still
  # running - the precise failure this file exists to prevent. Distinguish
  # "bottega said nothing" from "bottega did not answer".
  inbox_err=$(mktemp)
  runs_err=$(mktemp)
  inbox_raw=$(CLAUDE_CODE_SESSION_ID="$SID" "$BOTTEGA" question inbox --all --json 2>"$inbox_err"); inbox_rc=$?
  runs_raw=$("$BOTTEGA" run list --live --json 2>"$runs_err"); runs_rc=$?
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
out, ids, roots, stalled, stalled_subjects = [], [], [], [], []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
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
    if not isinstance(d.get("record_id"), str) or not isinstance(d.get("number"), int) or not isinstance(d.get("job"), str):
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
    status = d.get("live_member_status")
    if not isinstance(status, str):
        raise SystemExit(2)
    live_statuses = d.get("live_statuses")
    if not isinstance(live_statuses, list) or not all(isinstance(value, str) for value in live_statuses):
        raise SystemExit(2)
    if status not in live_statuses:
        raise SystemExit(2)
    member_number = d.get("live_member_number")
    member_id = d.get("live_member_id")
    if not isinstance(member_number, int) or not isinstance(member_id, str):
        raise SystemExit(2)
    timing = d
    if d.get("turns") is not None:
        if not isinstance(d["turns"], list) or not d["turns"]:
            raise SystemExit(2)
        timing = d["turns"][-1]
        if not isinstance(timing, dict) or not isinstance(timing.get("started_at"), str):
            raise SystemExit(2)
    try:
        started = datetime.datetime.fromisoformat(timing["started_at"].replace("Z", "+00:00"))
        el = int((now - started).total_seconds())
        age = "%dm%02ds" % (el // 60, el % 60)
    except Exception:
        age = "?"
    idle = d.get("idle")
    idle_note = ""
    if isinstance(idle, str) and idle.startswith("idle "):
        idle_note = " " + idle
    stall_state = d.get("stall_state")
    host_wait_since = d.get("host_wait_since")
    if host_wait_since is not None and not isinstance(host_wait_since, str):
        raise SystemExit(2)
    waiting_for_host_capacity = d.get("waiting_for_host_capacity")
    if not isinstance(waiting_for_host_capacity, bool):
        raise SystemExit(2)
    if waiting_for_host_capacity and host_wait_since is None:
        raise SystemExit(2)
    if status == "running" and stall_state not in ("healthy", "stalled", "unknown"):
        raise SystemExit(2)
    stall = d.get("stall")
    if stall_state == "stalled":
        if not isinstance(stall, str) or not stall:
            raise SystemExit(2)
        stalled.append(stall.replace("\t", " ").replace("\r", " ").replace("\n", " "))
        stalled_subjects.append("run:" + str(member_id))
    # A host waiter has no worker activity to become idle. The listing idle
    # label still crosses its display threshold while queued, but that hidden
    # transition must not turn an unchanged host wait into a new heartbeat state.
    ids.append(member_id + ("s" if stall_state == "stalled" else ("i" if idle_note and not waiting_for_host_capacity else "")))
    roots.append(d["record_id"])
    display = ("waiting for host capacity since " + host_wait_since) if waiting_for_host_capacity else (status + " " + age + idle_note)
    out.append("%s/%s %s %s" % (member_number, d.get("job"), d.get("agent"), display))
# count \t detail \t state-key (ids only - elapsed must never enter the key)
print("STATE", len(out), " | ".join(out), ",".join(sorted(ids)), len(stalled),
      ",".join(sorted(stalled_subjects)), " | ".join(stalled), ",".join(sorted(roots)), sep="\t")
') ; runs_parse_rc=$?

  # `--live` deliberately contains no terminal rows. Compare its exact chain
  # ids with the prior tick and look up only chains that disappeared, by id and
  # without a status filter, so completion notices never depend on recency.
  completion_observed=""
  completion_rc=0
  completion_parse_rc=0
  current_live_roots=""
  if [ "$runs_rc" -eq 0 ] && [ "$runs_parse_rc" -eq 0 ]; then
    current_live_roots=$(printf '%s\n' "$observed" | awk -F '\t' '$1 == "STATE" {print $8; exit}')
    missing_live_roots=""
    if [ -n "$previous_live_roots" ]; then
      IFS=',' read -r -a prior_roots <<< "$previous_live_roots"
      for root_id in "${prior_roots[@]}"; do
        [ -n "$root_id" ] || continue
        case ",$current_live_roots," in
          *",$root_id,"*) ;;
          *) missing_live_roots="${missing_live_roots}${missing_live_roots:+,}$root_id" ;;
        esac
      done
    fi
    if [ -n "$missing_live_roots" ]; then
      completion_args=(run list --json)
      IFS=',' read -r -a missing_roots <<< "$missing_live_roots"
      for root_id in "${missing_roots[@]}"; do
        completion_args+=(--id "$root_id")
      done
      completion_raw=$("$BOTTEGA" "${completion_args[@]}" 2>/dev/null); completion_rc=$?
      completion_observed=$(printf '%s' "$completion_raw" | MISSING_ROOTS="$missing_live_roots" python3 -c '
import json, os, sys
expected = set(filter(None, os.environ["MISSING_ROOTS"].split(",")))
seen = set()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
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
    root_id = d.get("record_id")
    if root_id not in expected or root_id in seen:
        raise SystemExit(2)
    seen.add(root_id)
    if not isinstance(d.get("number"), int) or not all(isinstance(d.get(key), str) for key in ("status", "job", "agent")):
        raise SystemExit(2)
    status = d.get("live_member_status")
    if not isinstance(status, str):
        raise SystemExit(2)
    if status == "ok":
        outcome = "FINISHED"
    elif status in ("failed", "stale", "stopped", "abandoned"):
        outcome = "HARNESS-REFUSED" if d.get("failure_kind") == "harness" else "FAILED"
    else:
        raise SystemExit(2)
    timing = d
    turns = d.get("turns")
    if turns is not None:
        if not isinstance(turns, list) or not turns or not isinstance(turns[-1], dict):
            raise SystemExit(2)
        timing = turns[-1]
    latency = timing.get("latency_ms")
    if latency is not None and not isinstance(latency, (int, float)):
        raise SystemExit(2)
    if latency is None:
        duration = "?"
    elif latency < 60000:
        duration = "%.1fs" % (latency / 1000)
    else:
        seconds = round(latency / 1000)
        duration = "%dm%02ds" % (seconds // 60, seconds % 60)
    print("EVENT", root_id, d["number"], outcome, d["job"], d["agent"],
          d.get("failure_kind") or "-", duration, sep="\t")
if seen != expected:
    raise SystemExit(2)
' 2>/dev/null); completion_parse_rc=$?
    fi
  fi

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
        "SELECT record_id, branch, status, started_at, finished_at FROM landing "
        "WHERE session_id = ? AND status IN (\"queued\",\"running\") ORDER BY record_id",
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
    if not isinstance(landing_id, str) or not all(isinstance(v, str) for v in (branch, status, started_at)):
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
     [ "$completion_rc" -ne 0 ] || [ "$completion_parse_rc" -ne 0 ] || \
     [ "$landings_parse_rc" -ne 0 ]; then
    key="degraded"
    since_emit=$((since_emit + 1))
    if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
      prev_key="$key"; since_emit=0
      echo "[$(date +%H:%M:%S)] DEGRADED - bottega observation failed (inbox rc=$inbox_rc parse=$inbox_parse_rc, runs rc=$runs_rc parse=$runs_parse_rc, completion rc=$completion_rc parse=$completion_parse_rc, landings parse=$landings_parse_rc). State unknown; NOT concluding clear. Inspect bottega diagnostics directly."
      report_store_write_lock
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
  stalled_subjects=${rest%%$'\t'*}; rest=${rest#*$'\t'}
  stalled_detail=${rest%%$'\t'*}; live_roots=${rest#*$'\t'}
  n=${n:-0}
  stalled_n=${stalled_n:-0}
  landing_state=${landings_observed%%$'\n'*}
  landing_state=${landing_state#*$'\t'}
  landing_n=${landing_state%%$'\t'*}; landing_rest=${landing_state#*$'\t'}
  landing_detail=${landing_rest%%$'\t'*}; landing_ids=${landing_rest#*$'\t'}
  landing_n=${landing_n:-0}

  while IFS=$'\t' read -r record record_id id outcome job agent failure_kind latency; do
    [ "$record" = "EVENT" ] || continue
    case " $reported_ids " in
      *" $record_id "*) continue ;;
    esac
    reported_ids="$reported_ids $record_id"
    if [ "$outcome" = "FINISHED" ]; then
      echo "FINISHED $id/$job $agent $latency"
    elif [ "$outcome" = "HARNESS-REFUSED" ]; then
      echo "HARNESS-REFUSED $id/$job $agent $failure_kind $latency; inspect with 'bottega run show $id'"
    else
      echo "FAILED $id/$job $agent $failure_kind $latency; inspect with 'bottega run show $id'"
    fi
  done <<< "$completion_observed"
  previous_live_roots="$live_roots"

  key="$asking|$n|$ids|$landing_n|$landing_ids"
  since_emit=$((since_emit + 1))
  direct_stalled_subjects=""
  combined_detail="$detail"
  if [ -n "$landing_detail" ]; then
    [ -z "$combined_detail" ] || combined_detail="$combined_detail | "
    combined_detail="$combined_detail$landing_detail"
  fi
  decision_output=$(HEARTBEAT_TIMESTAMP=$(date +%H:%M:%S) \
    HEARTBEAT_ASKING="$asking" HEARTBEAT_RUNS="$n" HEARTBEAT_LANDINGS="$landing_n" \
    HEARTBEAT_STALLED="$stalled_n" HEARTBEAT_STALLED_DETAIL="$stalled_detail" \
    HEARTBEAT_WAITING_DETAIL="$combined_detail" \
      python3 "$ROOT/hooks/heartbeat-decision.py" tick)
  decision_rc=$?
  if [ "$decision_rc" -eq "$HEARTBEAT_CLEAR_EXIT_STATUS" ]; then
    should_exit=1
  elif [ "$decision_rc" -eq "$HEARTBEAT_KEEP_LOOP_EXIT_STATUS" ]; then
    should_exit=0
  else
    should_exit=0
    echo "[$(date +%H:%M:%S)] DEGRADED - heartbeat decision step failed with status $decision_rc; continuing to watch."
  fi
  if [ "$key" != "$prev_key" ] || [ "$since_emit" -ge "$KEEPALIVE_TICKS" ]; then
    prev_key="$key"; since_emit=0
    [ -z "$decision_output" ] || printf '%s\n' "$decision_output"
    if [ "$stalled_n" -gt 0 ]; then
      direct_stalled_subjects="$stalled_subjects"
    fi
  fi

  # Health above is complete and, when actionable, already on stdout. Only now
  # may supplemental notice work begin; neither a fetch nor an acknowledgement
  # can suppress BLOCKED/WAITING/CLEAR for this tick.
  monitor_err=$(mktemp)
  monitor_out=$(mktemp)
  monitor_timed_out=$(mktemp)
  CLAUDE_CODE_SESSION_ID="$SID" "$BOTTEGA" machine monitor --notices --json >"$monitor_out" 2>"$monitor_err" &
  ACTIVE_GUARDED_PID=$!
  start_watchdog "$ACTIVE_GUARDED_PID" "$monitor_timed_out"
  ACTIVE_WATCHDOG_PID=$WATCHDOG_PID
  wait "$ACTIVE_GUARDED_PID"; monitor_rc=$?
  ACTIVE_GUARDED_PID=""
  cancel_watchdog "$ACTIVE_WATCHDOG_PID"
  ACTIVE_WATCHDOG_PID=""
  monitor_raw=$(<"$monitor_out")
  if [ -s "$monitor_timed_out" ]; then monitor_rc=124; fi
  monitor_reason=$(python3 "$ROOT/hooks/heartbeat-decision.py" <"$monitor_err")
  rm -f "$monitor_err" "$monitor_out" "$monitor_timed_out"

  monitor_observed=$(printf '%s' "$monitor_raw" | SID="$SID" STALLED_SUBJECTS="$direct_stalled_subjects" python3 -c '
import sys, json, os, uuid
try:
    result = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if isinstance(result, list):
    rows = result
    warning = None
elif isinstance(result, dict):
    rows = result.get("notices")
    warning = result.get("warning")
else:
    raise SystemExit(2)
if not isinstance(rows, list) or (warning is not None and not isinstance(warning, str)):
    raise SystemExit(2)
if warning:
    print("warning\t" + warning.replace("\t", " ").replace("\r", " ").replace("\n", " "))
for row in rows:
    if not isinstance(row, dict) or not isinstance(row.get("noticeId"), str):
        raise SystemExit(2)
    source, separator, identifier = row["noticeId"].partition(":")
    numeric = identifier.isdigit() and int(identifier) > 0
    try:
        hosted = source == "board" and str(uuid.UUID(identifier)) == identifier.lower() if not numeric else False
    except (ValueError, AttributeError):
        raise SystemExit(2)
    if source not in ("condition", "landing", "board") or separator != ":" or not (numeric or hosted):
        raise SystemExit(2)
    if not all(isinstance(row.get(key), str) for key in ("kind", "subject", "label", "detail")):
        raise SystemExit(2)
    if row.get("ownerSession") != os.environ["SID"]:
        raise SystemExit(2)
    values = [row[key].replace("\t", " ").replace("\r", " ").replace("\n", " ")
              for key in ("kind", "subject", "label", "detail")]
    directly_reported = set(filter(None, os.environ["STALLED_SUBJECTS"].split(",")))
    message = "" if values[0] == "stalled-run" and values[1] in directly_reported else (values[3] if values[0].startswith("landing-") else (
        "MONITOR " + values[0] + " " + values[2] + ": " + values[3]
    ))
    print(str(row["noticeId"]) + "\t" + message)
' 2>/dev/null); monitor_parse_rc=$?

  if [ "$monitor_rc" -ne 0 ] || [ "$monitor_parse_rc" -ne 0 ]; then
    monitor_failure_key="$monitor_rc|$monitor_parse_rc|$monitor_reason"
    monitor_failure_ticks=$((monitor_failure_ticks + 1))
    if [ "$monitor_failure_key" != "$prev_monitor_failure_key" ] || \
       [ "$monitor_failure_ticks" -ge "$KEEPALIVE_TICKS" ]; then
      prev_monitor_failure_key="$monitor_failure_key"
      monitor_failure_ticks=0
      printf '[%s] DEGRADED - monitor notices unavailable (rc=%s parse=%s reason=%s). Health state still follows inbox and runs; inspect monitor diagnostics directly.\n' \
        "$(date +%H:%M:%S)" "$monitor_rc" "$monitor_parse_rc" "$monitor_reason"
    fi
    report_store_write_lock
  else
    prev_monitor_failure_key=""
    monitor_failure_ticks=0
  fi
  if [ "$monitor_rc" -eq 0 ] && [ "$monitor_parse_rc" -eq 0 ] && [ -n "$monitor_observed" ]; then
    monitor_ids=$(printf '%s\n' "$monitor_observed" | awk -F '\t' '$1 != "warning" {print $1}' | paste -sd, -)
    if [ -z "$monitor_ids" ]; then
      printf '%s\n' "$monitor_observed" | cut -f2- | awk 'length > 0'
    else
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
        cap_failure_state="$cap_mint_rc"
        cap_failure_ticks=$((cap_failure_ticks + 1))
        if [ "$cap_failure_state" != "$prev_cap_failure_state" ] || \
           [ "$cap_failure_ticks" -ge "$KEEPALIVE_TICKS" ]; then
          prev_cap_failure_state="$cap_failure_state"
          cap_failure_ticks=0
          echo "[$(date +%H:%M:%S)] DEGRADED - monitor notice delivery capability unavailable. Health state still follows inbox and runs."
        fi
      else
        prev_cap_failure_state=""
        cap_failure_ticks=0
        if printf '%s\n' "$monitor_observed" | cut -f2- | awk 'length > 0'; then
          export ORCH_MONITOR_CAPABILITY_PATH="$CAP_PATH"
          export ORCH_MONITOR_CAPABILITY_TOKEN="$CAP_TOKEN"
          ack_timed_out=$(mktemp)
          CLAUDE_CODE_SESSION_ID="$SID" "$BOTTEGA" machine monitor --ack-notices "$monitor_ids" >/dev/null 2>&1 &
          ACTIVE_GUARDED_PID=$!
          start_watchdog "$ACTIVE_GUARDED_PID" "$ack_timed_out"
          ACTIVE_WATCHDOG_PID=$WATCHDOG_PID
          wait "$ACTIVE_GUARDED_PID"; ack_rc=$?
          ACTIVE_GUARDED_PID=""
          cancel_watchdog "$ACTIVE_WATCHDOG_PID"
          ACTIVE_WATCHDOG_PID=""
          if [ -s "$ack_timed_out" ]; then ack_rc=124; fi
          rm -f "$ack_timed_out"
          rm -rf "$CAP_DIR"
          unset ORCH_MONITOR_CAPABILITY_PATH ORCH_MONITOR_CAPABILITY_TOKEN
          if [ "$ack_rc" -ne 0 ]; then
            ack_failure_state="$ack_rc"
            ack_failure_ticks=$((ack_failure_ticks + 1))
            if [ "$ack_failure_state" != "$prev_ack_failure_state" ] || \
               [ "$ack_failure_ticks" -ge "$KEEPALIVE_TICKS" ]; then
              prev_ack_failure_state="$ack_failure_state"
              ack_failure_ticks=0
              echo "[$(date +%H:%M:%S)] DEGRADED - monitor notice acknowledgement failed; delivered notices may repeat. Health state still follows inbox and runs."
            fi
          else
            prev_ack_failure_state=""
            ack_failure_ticks=0
          fi
        fi
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
