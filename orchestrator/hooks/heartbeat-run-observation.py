#!/usr/bin/env python3
"""Parse the run-list JSON shape shared by heartbeat live and completion reads."""

import datetime
import json
import os
import sys


def observation_now_ms() -> int:
    """The instant this observation is made.

    BOTTEGA_HEARTBEAT_NOW_MS pins it so a test can judge a run's failover
    watch against a known instant rather than the clock it happens to run on.
    """
    pinned = os.environ.get("BOTTEGA_HEARTBEAT_NOW_MS")
    if pinned is not None and pinned.strip():
        return int(pinned)
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)


def run_row(line: str) -> dict:
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("run row is not an object")
    if "schema_version" in value:
        value = value.get("data")
        if not isinstance(value, dict):
            raise ValueError("run envelope has no object data")
    if not isinstance(value.get("record_id"), str) or not isinstance(value.get("number"), int):
        raise ValueError("run identity is invalid")
    if not all(isinstance(value.get(key), str) for key in ("job", "agent", "status")):
        raise ValueError("run presentation is invalid")
    value["executor"] = value.get("executor", "external")
    if value["executor"] not in ("external", "harness"):
        raise ValueError("run executor is invalid")
    if value.get("session_id") is not None and not isinstance(value.get("session_id"), str):
        raise ValueError("run session is invalid")
    if value.get("started_at") is not None and not isinstance(value.get("started_at"), str):
        raise ValueError("run start is invalid")
    if value.get("latency_ms") is not None and not isinstance(value.get("latency_ms"), (int, float)):
        raise ValueError("run latency is invalid")
    if value.get("failure_kind") is not None and not isinstance(value.get("failure_kind"), str):
        raise ValueError("run failure kind is invalid")
    successor = value.get("automatic_failover_successor")
    if successor is not None and (
        not isinstance(successor, dict)
        or not isinstance(successor.get("number"), int)
        or not isinstance(successor.get("agent"), str)
    ):
        raise ValueError("run automatic failover successor is invalid")
    watch_until = value.get("automatic_failover_watch_until")
    if watch_until is not None and not isinstance(watch_until, str):
        raise ValueError("run automatic failover watch is invalid")
    if not isinstance(value.get("live_member_id"), str):
        raise ValueError("run member id is invalid")
    if not isinstance(value.get("live_member_number"), int):
        raise ValueError("run member number is invalid")
    if not isinstance(value.get("live_member_status"), str):
        raise ValueError("run member status is invalid")
    turns = value.get("turns")
    if turns is not None and (
        not isinstance(turns, list)
        or not turns
        or not all(isinstance(turn, dict) for turn in turns)
    ):
        raise ValueError("run turns are invalid")
    return value


def timing_row(row: dict) -> dict:
    turns = row.get("turns")
    if turns is None:
        return row
    identified = [turn for turn in turns if isinstance(turn.get("record_id"), str)]
    if not identified:
        return turns[-1]
    matching = [turn for turn in identified if turn["record_id"] == row["live_member_id"]]
    if len(matching) != 1:
        raise ValueError("run member turn is missing or duplicated")
    return matching[0]


def successor_note(row: dict) -> str | None:
    """The clause naming a started automatic failover successor, or nothing."""
    successor = row.get("automatic_failover_successor")
    if not isinstance(successor, dict):
        return None
    return "; automatic failover started run %s on %s" % (successor["number"], successor["agent"])


def failover_watch_open(row: dict, now_ms: int) -> bool:
    """Whether this run may still gain an automatic failover successor.

    The run listing owns the window: it publishes the instant after which the
    successor is no longer worth waiting for, and publishes nothing when none
    can start at all. This only holds the clock against that instant.
    """
    until = row.get("automatic_failover_watch_until")
    if not isinstance(until, str):
        return False
    try:
        watch_until = datetime.datetime.fromisoformat(until.replace("Z", "+00:00"))
    except ValueError:
        return False
    return int(watch_until.timestamp() * 1000) > now_ms


def lines() -> list[dict]:
    return [run_row(line.strip()) for line in sys.stdin if line.strip()]


def live(session_id: str) -> None:
    now = datetime.datetime.now(datetime.timezone.utc)
    out, ids, roots, stalled, stalled_subjects = [], [], [], [], []
    live_statuses = None
    for row in lines():
        statuses = row.get("live_statuses")
        if not isinstance(statuses, list) or not statuses or not all(isinstance(value, str) for value in statuses):
            raise ValueError("live statuses are invalid")
        if live_statuses is None:
            live_statuses = statuses
        elif statuses != live_statuses:
            raise ValueError("live status definitions disagree")
        if row.get("session_id") != session_id:
            continue
        status = row["live_member_status"]
        if status not in statuses:
            raise ValueError("listed member is not live")
        timing = timing_row(row)
        if not isinstance(timing.get("started_at"), str):
            raise ValueError("live member start is invalid")
        try:
            started = datetime.datetime.fromisoformat(timing["started_at"].replace("Z", "+00:00"))
            elapsed = int((now - started).total_seconds())
            age = "%dm%02ds" % (elapsed // 60, elapsed % 60)
        except Exception:
            age = "?"
        idle = row.get("idle")
        idle_note = " " + idle if isinstance(idle, str) and idle.startswith("idle ") else ""
        stall_state = row.get("stall_state")
        host_wait_since = row.get("host_wait_since")
        if host_wait_since is not None and not isinstance(host_wait_since, str):
            raise ValueError("host wait start is invalid")
        waiting = row.get("waiting_for_host_capacity")
        if not isinstance(waiting, bool) or (waiting and host_wait_since is None):
            raise ValueError("host wait state is invalid")
        waiting_for_capacity = row.get("waiting_for_capacity", False)
        if not isinstance(waiting_for_capacity, bool):
            raise ValueError("agent capacity wait state is invalid")
        throttled = row.get("throttled")
        live_status_detail = row.get("live_status_detail")
        if (waiting_for_capacity or isinstance(throttled, dict)) and not isinstance(live_status_detail, str):
            raise ValueError("live operational status detail is invalid")
        if status == "running" and stall_state not in ("healthy", "stalled", "unknown"):
            raise ValueError("stall state is invalid")
        stall = row.get("stall")
        member_id = row["live_member_id"]
        if stall_state == "stalled":
            if not isinstance(stall, str) or not stall:
                raise ValueError("stall detail is invalid")
            stalled.append(stall.replace("\t", " ").replace("\r", " ").replace("\n", " "))
            stalled_subjects.append("run:" + member_id)
        ids.append(member_id + ("s" if stall_state == "stalled" else ("i" if idle_note and not waiting else "")))
        roots.append(row["record_id"])
        display = (
            "waiting for host capacity since " + host_wait_since
            if waiting
            else live_status_detail
            if waiting_for_capacity or isinstance(throttled, dict)
            else status + " " + age + idle_note
        )
        executor = " executor:harness" if row["executor"] == "harness" else ""
        out.append("%s/%s %s%s %s" % (row["live_member_number"], row["job"], row["agent"], executor, display))
    print(
        "STATE", len(out), " | ".join(out), ",".join(sorted(ids)), len(stalled),
        ",".join(sorted(stalled_subjects)), " | ".join(stalled), ",".join(sorted(roots)),
        ",".join(live_statuses or []), sep="\t",
    )


def completion(expected_csv: str, watched_csv: str, live_statuses_csv: str) -> None:
    """Report every listed terminal run, and which of them still await a successor.

    Two requests arrive together and are treated differently. A root the caller
    has just watched disappear is *expected* to be terminal, so a live member
    there is a disagreement to raise. A root the caller has been watching for a
    successor may instead have been continued: one whose latest member is live
    again leaves the watch silently, with no line, and is announced normally at
    its next terminal state.

    The WATCH row hands the caller back the roots worth rereading: a failed run
    whose automatic failover successor has not appeared yet, while the instant
    the run listing publishes as the end of that wait is still ahead.
    """
    expected = set(filter(None, expected_csv.split(",")))
    watched_in = set(filter(None, watched_csv.split(",")))
    live_statuses = set(filter(None, live_statuses_csv.split(",")))
    if not live_statuses:
        raise ValueError("live statuses unavailable")
    now_ms = observation_now_ms()
    seen, watched = set(), []
    for row in lines():
        root_id = row["record_id"]
        if root_id not in expected and root_id not in watched_in:
            raise ValueError("unexpected completion row")
        if root_id in seen:
            raise ValueError("duplicated completion row")
        seen.add(root_id)
        status = row["live_member_status"]
        if status in live_statuses:
            if root_id not in expected:
                # A watched failure that is live again was continued, not lost.
                continue
            raise ValueError("disappeared chain is still live")
        outcome = "FINISHED" if status == "ok" else "FAILED"
        if outcome == "FAILED" and row.get("failure_kind") == "harness":
            outcome = "HARNESS-REFUSED"
        timing = timing_row(row)
        latency = timing.get("latency_ms")
        if latency is not None and not isinstance(latency, (int, float)):
            raise ValueError("completion latency is invalid")
        if latency is None:
            duration = "?"
        elif latency < 60000:
            duration = "%.1fs" % (latency / 1000)
        else:
            seconds = round(latency / 1000)
            duration = "%dm%02ds" % (seconds // 60, seconds % 60)
        note = successor_note(row) if outcome == "FAILED" else None
        if outcome == "FAILED" and failover_watch_open(row, now_ms):
            watched.append(root_id)
        print(
            "EVENT", root_id, row["live_member_id"], row["live_member_number"], outcome,
            row["job"], row["agent"], row.get("failure_kind") or "-", duration, note or "-",
            sep="\t",
        )
    if seen != expected | watched_in:
        raise ValueError("completion row missing")
    print("WATCH", ",".join(sorted(watched)), sep="\t")


try:
    if sys.argv[1:2] == ["live"] and len(sys.argv) == 3:
        live(sys.argv[2])
    elif sys.argv[1:2] == ["completion"] and len(sys.argv) == 5:
        completion(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise ValueError("invalid heartbeat observation command")
except (ValueError, json.JSONDecodeError):
    raise SystemExit(2)
