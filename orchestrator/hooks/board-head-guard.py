#!/usr/bin/env python3
"""Refuse production orchestrator edits that add unheaded local board SQL."""

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from registered_scope import should_hook_act
from hook_emission import record_emission
from hook_paths import bottega_bin


JUDGE_TIMEOUT_SECONDS = 2
EDITOR_TOOLS = {"Write", "Edit", "MultiEdit"}
PRODUCTION_SOURCE = re.compile(r"(?:^|/)orchestrator/src/.*\.ts$")
TEST_SOURCE = re.compile(r"\.test\.ts$")
BOARD_TEXT = re.compile(
    r"\bboard_[a-z0-9_]+\b|\b(?:from\s*|import\s*\()\s*['\"][^'\"]*board-store(?:\.[cm]?[jt]s)?['\"]",
    re.IGNORECASE,
)
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


def precheck_text(payload, path):
    pieces = [json.dumps(payload.get("tool_input", {}), separators=(",", ":"))]
    try:
        with open(path, "r", encoding="utf-8") as source:
            pieces.append(source.read())
    except FileNotFoundError:
        pass
    return "\n".join(pieces)


def should_check_board_head(payload, path):
    if payload.get("tool_name") not in EDITOR_TOOLS or path is None:
        return False
    normalized = path.replace(os.sep, "/")
    return (
        PRODUCTION_SOURCE.search(normalized) is not None
        and TEST_SOURCE.search(normalized) is None
        and BOARD_TEXT.search(precheck_text(payload, path)) is not None
    )


def unchecked(file, reason):
    print(
        f"board-head-guard: {file} was not checked: {reason}; "
        "bun scripts/check-hosted-local-sql.ts is the backstop",
        file=sys.stderr,
    )
    return 0


def judge_environment():
    return {key: os.environ[key] for key in JUDGE_ENVIRONMENT_KEYS if key in os.environ}


def deny(payload, findings):
    details = [
        f"{finding.get('rule', '<unknown rule>')}: {finding.get('dependency', '<unknown site>')}"
        for finding in findings
    ]
    reason = "refusing edit because local board SQL has no local-board head:\n" + "\n".join(details)
    record_emission(payload, "denyReason", reason)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    return 0


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        return unchecked("<unknown orchestrator file>", f"invalid hook input ({error})")
    if not should_hook_act(payload):
        return 0
    path = target_path(payload)
    if not should_check_board_head(payload, path):
        return 0

    try:
        result = subprocess.run(
            [bottega_bin(), "gate", "board-head", "judge", "--tool-input"],
            input=json.dumps(payload),
            capture_output=True,
            env=judge_environment(),
            text=True,
            timeout=JUDGE_TIMEOUT_SECONDS,
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
        return deny(payload, judgment.get("findings", []))
    if judgment.get("status") == "ok":
        return 0
    return unchecked(path, judgment.get("reason") or "judge returned no decision")


if __name__ == "__main__":
    raise SystemExit(main())
