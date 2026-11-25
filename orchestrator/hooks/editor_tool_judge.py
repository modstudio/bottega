"""Shared PreToolUse editor-judge invocation, fail-open reporting, and denial shell."""

import json
import os
import subprocess
import sys
import time

from hook_emission import record_emission
from hook_paths import bottega_bin
from registered_scope import should_hook_act

EDITOR_TOOLS = {"Write", "Edit", "MultiEdit"}
JUDGE_ENVIRONMENT_KEYS = (
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "BOTTEGA_ORCHESTRATOR_DB", "BOTTEGA_STATE_HOME", "XDG_STATE_HOME",
)


class UnsupportedEditorShape(Exception):
    pass


def target_path(payload):
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    raw = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(raw, str) or not raw:
        return None
    if os.path.isabs(raw):
        return os.path.abspath(raw)
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.getcwd()
    return os.path.abspath(os.path.join(cwd, raw))


def unchecked(guard_name, file, reason, backstop):
    print(f"{guard_name}: {file} was not checked: {reason}; {backstop}", file=sys.stderr)
    return 0


def deny(payload, reason):
    record_emission(payload, "denyReason", reason)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    return 0


def run_editor_tool_judge(*, guard_name, subject, subcommand, timeout_seconds, precheck,
                          denial_reason, backstop, deadline=False):
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        return unchecked(guard_name, f"<unknown {subject} file>", f"invalid hook input ({error})", backstop)
    if not should_hook_act(payload):
        return 0
    path = target_path(payload)
    try:
        if not precheck(payload, path):
            return 0
    except UnsupportedEditorShape as error:
        return unchecked(guard_name, path, str(error), backstop)

    deadline_ms = int((time.time() + timeout_seconds) * 1000)
    command = [bottega_bin(), *subcommand, "--tool-input"]
    if deadline:
        command.extend(["--deadline-ms", str(deadline_ms)])
    environment = {key: os.environ[key] for key in JUDGE_ENVIRONMENT_KEYS if key in os.environ}
    try:
        result = subprocess.run(
            command,
            input=json.dumps(payload),
            capture_output=True,
            env=environment,
            text=True,
            timeout=max(0.001, (deadline_ms / 1000) - time.time()) if deadline else timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return unchecked(guard_name, path, f"judge timed out after {timeout_seconds} seconds", backstop)
    except OSError as error:
        return unchecked(guard_name, path, f"judge could not start ({error})", backstop)
    if result.returncode != 0:
        detail = result.stderr.strip().replace("\n", " ") or f"exit {result.returncode}"
        return unchecked(guard_name, path, f"judge failed ({detail})", backstop)
    try:
        judgment = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return unchecked(guard_name, path, f"judge returned invalid JSON ({error})", backstop)
    if judgment.get("status") == "refused":
        return deny(payload, denial_reason(judgment.get("findings", [])))
    if judgment.get("status") == "ok":
        return 0
    return unchecked(guard_name, path, judgment.get("reason") or "judge returned no decision", backstop)
