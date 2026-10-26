#!/usr/bin/env python3
"""Stop hook: live detached work must not silently lose its watcher.

A session can finish its turn while its workers are still running or waiting on
a ruling, leaving the operator unable to distinguish progress from abandonment.
The first stop is held long enough to arm Monitor. A dead worker can remain
recorded live forever, so the same observed run set is never allowed to wedge a
session on every later stop.
"""
from __future__ import annotations  # bool | None must parse on macOS system python 3.9

import hashlib
import importlib.util
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import uuid


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
PROCESS_LIST_PS_TIMEOUT_SECONDS = 2
DB = os.environ.get("BOTTEGA_ORCHESTRATOR_DB") or subprocess.check_output(
    ["bun", "--no-env-file", os.path.join(ROOT, "shared", "state-directory.ts"), "orchestrator", "database"],
    text=True,
).strip()


def load_hook_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(os.path.dirname(__file__), filename))
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def heartbeat_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "orch-heartbeat.sh"))


def bottega_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "bottega"))


def uuid_string(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def heartbeat_armed(session_id: str) -> bool | None:
    process_list = os.environ.get("BOTTEGA_HEARTBEAT_PROCESS_LIST")
    if process_list is None:
        try:
            observed = subprocess.run(
                ["ps", "-axo", "pid=,args="],
                capture_output=True,
                text=True,
                timeout=PROCESS_LIST_PS_TIMEOUT_SECONDS,
                check=True,
            )
            process_list = observed.stdout
        except Exception:
            return None
    for line in process_list.splitlines():
        try:
            _, command = line.strip().split(None, 1)
            words = shlex.split(command)
        except (ValueError, IndexError):
            continue
        for index, word in enumerate(words[:-1]):
            if os.path.basename(word) == "orch-heartbeat.sh" and words[index + 1] == session_id:
                return True
    return False


def landing_db_path() -> str:
    return DB


def live_landing_ids(session_id: str):
    """Landings this session has queued or running, [] if none, None if unknowable.

    A landing is NOT a run and has no row in the run table, so a session whose
    only work is a landing reads as idle to a runs-only check -- and the
    heartbeat then reports CLEAR, which is a positive claim of quiescence over
    a live ten-minute gate rather than merely a missing one. That false
    all-clear is the exact outcome orch-heartbeat.sh's own header warns about,
    reached by a route it did not anticipate.

    Absent store and unreadable store are deliberately different answers. No
    database means landings are not a concept in reach here (a session in
    another project, a fixture), so there is nothing to report. A database that
    exists but will not answer is genuine uncertainty, and the caller treats
    that as live: being wrong toward "work exists" costs one blocked stop that
    the one-shot guard already releases, while being wrong toward "clear"
    reproduces the failure this function exists to close.
    """
    path = landing_db_path()
    if not os.path.exists(path):
        return []
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        try:
            rows = connection.execute(
                "SELECT record_id FROM landing WHERE session_id = ? AND status IN ('queued','running')",
                (session_id,),
            ).fetchall()
        finally:
            connection.close()
        return sorted({int(row[0]) for row in rows})
    except Exception:
        return None


def live_run_ids(session_id: str):
    try:
        result = subprocess.run(
            [bottega_path(), "run", "list", "--limit", "200", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        ids = []
        for raw in result.stdout.splitlines():
            if not raw.strip():
                continue
            row = json.loads(raw)
            if not isinstance(row, dict):
                raise ValueError("run is not an object")
            data = row.get("data") if "schema_version" in row else row
            if not isinstance(data, dict):
                raise ValueError("run data is not an object")
            if data.get("session_id") == session_id and data.get("status") in ("running", "asking"):
                run_id = data.get("record_id")
                if not uuid_string(run_id):
                    raise ValueError("live run has no UUID record_id")
                ids.append(run_id)
        return sorted(set(ids))
    except Exception:
        return None


def open_request_threads(session_id: str, board_observation, heartbeat_decision):
    """Open requests authored here, [] if none, None if the store cannot answer."""
    try:
        rows = board_observation.observe_board_requests(
            DB, session_id, heartbeat_decision.contains_secret_shaped
        )
        roots = [root for root in rows["roots"] if root.get("author_session") == session_id]
        return heartbeat_decision.open_board_requests(
            roots, rows["replies"], session_id, __import__("time").time()
        )
    except Exception:
        return None


def first_observation(session_id: str, run_ids) -> bool:
    key = json.dumps([session_id, run_ids], separators=(",", ":"))
    name = hashlib.sha256(key.encode()).hexdigest()
    root = os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(), "orch-heartbeat-guard")
    try:
        os.makedirs(root, mode=0o700, exist_ok=True)
        marker = os.path.join(root, name)
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(key + "\n")
        return True
    except FileExistsError:
        return False
    except Exception:
        # State is part of the safety mechanism. If it cannot be recorded, a
        # block could repeat forever, so fail open rather than risk a wedge.
        return False


def main() -> int:
    try:
        try:
            heartbeat_decision = load_hook_module("heartbeat_decision", "heartbeat-decision.py")
            board_observation = load_hook_module(
                "heartbeat_board_observation", "heartbeat-board-observation.py"
            )
        except Exception:
            heartbeat_decision = board_observation = None
        payload = json.load(sys.stdin)
        sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not isinstance(sid, str) or not sid:
            return 0
        run_ids = live_run_ids(sid) or []
        landing_ids = live_landing_ids(sid)
        request_rows = (
            None
            if board_observation is None or heartbeat_decision is None
            else open_request_threads(sid, board_observation, heartbeat_decision)
        )
        # None from the landing query is uncertainty, not absence: count it as
        # live so an unreadable store cannot be reported as quiescence.
        landings = ["unknown"] if landing_ids is None else [str(i) for i in landing_ids]
        requests = [] if request_rows is None else request_rows
        if not run_ids and not landings and not requests and request_rows is not None:
            return 0

        arm = f"{heartbeat_path()} {sid}"

        armed = heartbeat_armed(sid)
        if armed is not False:
            return 0
        count = len(run_ids)
        landing_count = len(landings)
        request_count = len(requests)
        work = (
            f"{count} live bottega run{'s' if count != 1 else ''}"
            f" and {landing_count} landing{'s' if landing_count != 1 else ''}"
            f" and {request_count} open request{'s' if request_count != 1 else ''}"
        )
        if landing_ids is None:
            work += " (landing store unreadable; assuming live)"
        if request_rows is None:
            work += " (board store unreadable; open requests unknown)"
        elif requests:
            work += ": " + " | ".join(str(row["label"]) for row in requests)
        observed = [
            *run_ids,
            *[f"landing:{item}" for item in landings],
            *[f"request:{row['id']}" for row in requests],
        ]
        blocking_work = bool(run_ids or landings)
        if blocking_work and first_observation(sid, observed):
            reason = (
                f"{work} for this session have no heartbeat. "
                f"Arm under Monitor from the main checkout: {arm}"
            )
            sys.stdout.write(json.dumps({"decision": "block", "reason": reason}) + "\n")
        else:
            prefix = (
                "Allowing stop after the one-shot heartbeat guard: "
                if blocking_work
                else "Allowing stop: "
            )
            warning = (
                f"{prefix}{work} remain unarmed. "
                f"Arm under Monitor: {arm}"
            )
            sys.stdout.write(json.dumps({"systemMessage": warning}) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
