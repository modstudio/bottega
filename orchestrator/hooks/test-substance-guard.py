#!/usr/bin/env python3
"""Refuse JavaScript and TypeScript test edits that introduce substance findings."""

import json
import os
import subprocess
import sys


JUDGE_TIMEOUT_SECONDS = 2
TEST_SUFFIXES = tuple(
    f".{kind}.{extension}"
    for kind in ("test", "spec")
    for extension in ("js", "jsx", "mjs", "mjsx", "cjs", "cjsx", "ts", "tsx", "mts", "mtsx", "cts", "ctsx")
)
EDITOR_TOOLS = {"Write", "Edit", "MultiEdit"}


def target_path(payload):
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    raw = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(raw, str) or not raw:
        return None
    if os.path.isabs(raw):
        return raw
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.getcwd()
    return os.path.abspath(os.path.join(cwd, raw))


def unchecked(file, reason):
    print(
        f"test-substance-guard: {file} was not checked: {reason}; the gate is the backstop",
        file=sys.stderr,
    )
    return 0


def deny(findings):
    lines = ["refusing test edit because it introduces test-substance findings:"]
    for finding in findings:
        lines.append(
            f"{finding.get('test', '<unknown test>')}: {finding.get('rule', '<unknown rule>')} — "
            f"{finding.get('message', 'test has no substance')}"
        )
    lines.extend(
        [
            "make the test assert on the behaviour it names,",
            "delete the test, or",
            "add a waiver comment `test-substance-allow: <rule> <reason>` above it.",
        ]
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "\n".join(lines),
                }
            }
        )
    )
    return 0


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        return unchecked("<unknown test file>", f"invalid hook input ({error})")

    path = target_path(payload)
    if path is not None and not path.endswith(TEST_SUFFIXES):
        return 0
    if path is None or payload.get("tool_name") not in EDITOR_TOOLS:
        return unchecked(path or "<unknown test file>", "tool input is not a supported editor shape")

    install_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    orch = os.path.join(install_root, "bin", "orch")
    try:
        result = subprocess.run(
            [orch, "test-substance", "judge", "--tool-input"],
            input=json.dumps(payload),
            capture_output=True,
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
        return deny(judgment.get("findings", []))
    if judgment.get("status") == "ok":
        return 0
    return unchecked(path, judgment.get("reason") or "judge returned no decision")


if __name__ == "__main__":
    raise SystemExit(main())
