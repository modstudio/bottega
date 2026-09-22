#!/usr/bin/env python3
"""SessionStart and Stop hook: report open workflow cursors, never blocking.

Compact and resume remind the agent of this session's open cursors. Clear
labels open cursors in the project, which another session may be driving. Stop
names this session's open cursors to the operator. The reminder never emits a
blocking decision: an awaiting-ruling cursor is a legitimate stop, and a
blocking Stop hook loops.
"""
import json
import os
import subprocess
import sys

CLI_TIMEOUT_SECONDS = 5


def orch_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "orch")


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


def render_cursor_line(row):
    line = (
        f"{row['workflow_slug']} {row['workflow_key']} {row['project']} "
        f"step {row['ordinal'] + 1}/{row['total_steps']} {row['step_slug']} "
        f"{row['state']} next: {row['next_slug']}"
    )
    if row.get("question"):
        line += f" question: {row['question']}"
    return line


def parse_cursor_rows(stdout):
    text = (stdout or "").strip()
    if not text:
        return []
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("cursor JSON is not a list")
    required = (
        "workflow_slug",
        "workflow_key",
        "project",
        "step_slug",
        "state",
        "next_slug",
    )
    rows = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("cursor JSON row is not an object")
        if any(not isinstance(item.get(key), str) for key in required):
            raise ValueError("cursor JSON row is missing a string field")
        if not isinstance(item.get("ordinal"), int) or not isinstance(
            item.get("total_steps"), int
        ):
            raise ValueError("cursor JSON row has a non-integer step count")
        question = item.get("question")
        if question is not None and not isinstance(question, str):
            raise ValueError("cursor JSON row has a non-string question")
        rows.append(item)
    return rows


def query_cursors(cwd, session=None):
    command = [orch_bin(), "workflow", "cursors", "--json"]
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


def session_start_context(source, rows):
    if source == "clear":
        header = (
            "Open workflow cursors in this project, possibly driven by another session. "
            "Resume a flow with next_workflow_step (MCP) or orch workflow next."
        )
    else:
        header = (
            "Open workflow cursors. Resume a flow with next_workflow_step (MCP) "
            "or orch workflow next."
        )
    lines = [header]
    for row in rows:
        line = render_cursor_line(row)
        if row["state"] == "awaiting-ruling":
            line += " Ruling is pending."
        lines.append(line)
    return "\n".join(lines)


def stop_message(rows):
    return "\n".join(["Open workflow cursors."] + [render_cursor_line(row) for row in rows])


def handle_session_start(payload):
    source = payload.get("source")
    if source in ("compact", "resume"):
        session = payload_text(payload, "session_id")
        cwd = payload_text(payload, "cwd")
        if not session:
            emit_unknown("SessionStart", "payload session_id is missing")
            return
        if not cwd:
            emit_unknown("SessionStart", "payload cwd is missing")
            return
        rows, why = query_cursors(cwd, session=session)
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
    if rows:
        emit_stop(stop_message(rows))


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("hook payload is not an object")
    except Exception as error:
        print(
            f"orch: hook payload could not be parsed ({error.__class__.__name__}: {error})",
            file=sys.stderr,
        )
        return 0
    try:
        event = payload.get("hook_event_name")
        if event == "SessionStart":
            handle_session_start(payload)
        elif event == "Stop":
            handle_stop(payload)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
