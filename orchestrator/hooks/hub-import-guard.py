#!/usr/bin/env python3
"""Refuse hub source edits that violate the import architecture."""

import json
import os
import subprocess
import sys
import time


JUDGE_TIMEOUT_SECONDS = 8
EDITOR_TOOLS = {"Write", "Edit", "MultiEdit"}
JUDGE_ENVIRONMENT_KEYS = ("PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE")


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


def unchecked(file, reason):
    print(
        f"hub-import-guard: {file} was not checked: {reason}; the gate is the backstop",
        file=sys.stderr,
    )
    return 0


def judge_environment():
    return {key: os.environ[key] for key in JUDGE_ENVIRONMENT_KEYS if key in os.environ}


def deny(findings):
    details = [
        f"{finding.get('rule', '<unknown rule>')}: {finding.get('dependency', '<unknown import>')}"
        for finding in findings
    ]
    reason = "refusing hub edit because it violates an import boundary:\n" + "\n".join(details)
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    return 0


def main():
    deadline_ms = int((time.time() + JUDGE_TIMEOUT_SECONDS) * 1000)
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        return unchecked("<unknown hub file>", f"invalid hook input ({error})")
    path = target_path(payload)
    if path is None or "/hub/" not in path.replace(os.sep, "/"):
        return 0
    if payload.get("tool_name") not in EDITOR_TOOLS:
        return unchecked(path, "tool input is not a supported editor shape")
    install_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    binary = os.path.join(install_root, "bin", "bottega")
    try:
        result = subprocess.run(
            [
                binary,
                "gate",
                "hub-import",
                "judge",
                "--tool-input",
                "--deadline-ms",
                str(deadline_ms),
            ],
            input=json.dumps(payload),
            capture_output=True,
            env=judge_environment(),
            text=True,
            timeout=max(0.001, (deadline_ms / 1000) - time.time()),
        )
    except subprocess.TimeoutExpired:
        return unchecked(path, f"judge timed out after {JUDGE_TIMEOUT_SECONDS} seconds")
    except OSError as error:
        return unchecked(path, f"judge could not start ({error})")
    if result.returncode != 0:
        detail = result.stderr.strip().replace("\n", " ") or f"exit {result.returncode}"
        return unchecked(path, f"judge failed ({detail})")
    try:
        judgment = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return unchecked(path, f"judge returned invalid JSON ({error})")
    if judgment.get("status") == "refused":
        return deny(judgment.get("findings", []))
    if judgment.get("status") == "ok":
        return 0
    return unchecked(path, judgment.get("reason") or "judge returned no decision")


if __name__ == "__main__":
    raise SystemExit(main())
