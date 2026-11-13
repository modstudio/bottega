#!/usr/bin/env python3
"""SessionStart hook: report open workflow cursors.

Clear labels open cursors in the project, which another session may be driving.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from hook_paths import bottega_bin
from registered_scope import should_hook_act

CLI_TIMEOUT_SECONDS = 5

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


def emit_unknown(why):
    text = f"Workflow cursor state is unknown: {why}"
    emit_session_start(text)


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


def handle_session_start(payload):
    source = payload.get("source")
    if source in ("compact", "resume"):
        return
    elif source == "clear":
        cwd = payload_text(payload, "cwd")
        if not cwd:
            emit_unknown("payload cwd is missing")
            return
        rows, why = query_cursors(cwd)
    else:
        return
    if why is not None:
        emit_unknown(why)
        return
    if rows:
        emit_session_start(session_start_context(source, rows))


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
    except Exception as error:
        emit_unknown(f"hook failed ({error.__class__.__name__}: {error})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
