#!/usr/bin/env python3
"""SessionStart and Stop hook: report open workflow cursors, never blocking.

Clear labels open cursors in the project, which another session may be driving. Stop
names this session's open cursors to the operator. The reminder never emits a
blocking decision: an awaiting-ruling cursor is a legitimate stop, and a
blocking Stop hook loops.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from registered_scope import should_hook_act
from board_hook_common import marker_path, read_marker, write_marker

CLI_TIMEOUT_SECONDS = 5


def bottega_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "bottega")


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_session_start(text):
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": text,
            }
        }
    )


def emit_stop(text):
    emit({"systemMessage": text})


def emit_unknown(event, why):
    text = f"Workflow cursor state is unknown: {why}"
    if event == "SessionStart":
        emit_session_start(text)
    else:
        emit_stop(text)


def payload_text(payload, key):
    value = payload.get(key)
    return value if isinstance(value, str) and value else None


def first_stderr_line(stderr):
    for line in (stderr or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def parse_cursor_rows(stdout):
    text = (stdout or "").strip()
    if not text:
        return []
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("cursor JSON is not a list")
    required = ("line", "state")
    rows = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("cursor JSON row is not an object")
        if any(not isinstance(item.get(key), str) for key in required):
            raise ValueError("cursor JSON row is missing a string field")
        rows.append(item)
    return rows


def query_cursors(cwd, session=None):
    command = [bottega_bin(), "workflow", "cursors", "--json"]
    if session is not None:
        command.extend(["--session", session])
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as error:
        return None, str(error)
    if result.returncode != 0:
        why = f"exit {result.returncode}"
        first = first_stderr_line(result.stderr)
        if first:
            why += f": {first}"
        return None, why
    try:
        return parse_cursor_rows(result.stdout), None
    except (ValueError, json.JSONDecodeError):
        return None, "unparseable JSON"


def query_stale(cwd, session):
    command = [bottega_bin(), "agent", "context", "stale", "--session", session, "--json"]
    try:
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, timeout=CLI_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        return None
    except OSError:
        return None
    if result.returncode != 0:
        return None
    try:
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or any(
            not isinstance(row, dict) or not isinstance(row.get("holder"), str) for row in rows
        ):
            return None
        return rows
    except (ValueError, json.JSONDecodeError):
        return None


def session_start_context(source, rows):
    if source == "clear":
        header = (
            "Open workflow cursors in this project, possibly driven by another session. "
            "Resume a flow with next_workflow_step (MCP) or bottega workflow next."
        )
    else:
        header = (
            "Open workflow cursors. Resume a flow with next_workflow_step (MCP) "
            "or bottega workflow next."
        )
    lines = [header]
    for row in rows:
        line = row["line"]
        if row["state"] == "awaiting-ruling":
            line += " Ruling is pending."
        lines.append(line)
    return "\n".join(lines)


def stop_message(rows):
    return "\n".join(["Open workflow cursors."] + [row["line"] for row in rows])


def stale_message(rows):
    return "\n".join(
        [
            "Context next-action is stale for holders worked by this session:",
            *[f'{row["holder"]} (bottega agent context show --task {row["holder"]})' for row in rows],
        ]
    )


def marker_warning():
    return "Context stale reminder marker could not be written; repeats cannot be suppressed."


def unseen_stale_rows(session, rows):
    if not rows:
        return [], False
    event_set = [
        [row["holder"], row.get("workedAt"), row.get("revisedAt")]
        for row in rows
    ]
    path = marker_path("context-stale", session)
    prior = read_marker(path)
    if prior == event_set:
        return [], False
    return rows, not write_marker(path, event_set)


def handle_session_start(payload):
    source = payload.get("source")
    if source in ("compact", "resume"):
        return
    elif source == "clear":
        cwd = payload_text(payload, "cwd")
        if not cwd:
            emit_unknown("SessionStart", "payload cwd is missing")
            return
        rows, why = query_cursors(cwd)
    else:
        return
    if why is not None:
        emit_unknown("SessionStart", why)
        return
    if rows:
        emit_session_start(session_start_context(source, rows))


def handle_stop(payload):
    if payload.get("stop_hook_active"):
        return
    session = payload_text(payload, "session_id")
    cwd = payload_text(payload, "cwd")
    if not session:
        emit_unknown("Stop", "payload session_id is missing")
        return
    if not cwd:
        emit_unknown("Stop", "payload cwd is missing")
        return
    rows, why = query_cursors(cwd, session=session)
    if why is not None:
        emit_unknown("Stop", why)
        return
    messages = []
    if rows:
        messages.append(stop_message(rows))
    stale = query_stale(cwd, session)
    if stale:
        fresh, marker_failed = unseen_stale_rows(session, stale)
        if fresh:
            messages.append(stale_message(fresh))
            if marker_failed:
                messages.append(marker_warning())
    if messages:
        emit_stop("\n".join(messages))


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("hook payload is not an object")
    except Exception as error:
        print(
            f"bottega: hook payload could not be parsed ({error.__class__.__name__}: {error})",
            file=sys.stderr,
        )
        return 0
    if not should_hook_act(payload):
        return 0
    event = payload.get("hook_event_name")
    try:
        if event == "SessionStart":
            handle_session_start(payload)
        elif event == "Stop":
            handle_stop(payload)
    except Exception as error:
        emit_unknown(event, f"hook failed ({error.__class__.__name__}: {error})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
