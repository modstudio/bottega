#!/usr/bin/env python3
"""Refuse production orchestrator edits that add unheaded local board SQL."""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from editor_tool_judge import EDITOR_TOOLS, run_editor_tool_judge
from registered_scope import should_hook_act

JUDGE_TIMEOUT_SECONDS = 2

# Cheap mirror of boardHeadHookShouldAct in orchestrator/src/board-head-commands.ts.
PRODUCTION_SOURCE = re.compile(r"(?:^|/)orchestrator/src/.*\.ts$")
TEST_SOURCE = re.compile(r"\.test\.ts$")
BOARD_TEXT = re.compile(
    r"\bboard_[a-z0-9_]+\b|\b(?:from\s*|import\s*\()\s*['\"][^'\"]*board-store(?:\.[cm]?[jt]s)?['\"]",
    re.IGNORECASE,
)


def precheck_text(payload, path):
    pieces = [json.dumps(payload.get("tool_input", {}), separators=(",", ":"))]
    try:
        with open(path, "r", encoding="utf-8") as source:
            pieces.append(source.read())
    except FileNotFoundError:
        pass
    return "\n".join(pieces)


def should_check_board_head(payload, path):
    if not should_hook_act(payload):
        return False
    if payload.get("tool_name") not in EDITOR_TOOLS or path is None:
        return False
    normalized = path.replace(os.sep, "/")
    return (
        PRODUCTION_SOURCE.search(normalized) is not None
        and TEST_SOURCE.search(normalized) is None
        and BOARD_TEXT.search(precheck_text(payload, path)) is not None
    )


def refusal(findings):
    details = [
        f"{finding.get('rule', '<unknown rule>')}: {finding.get('dependency', '<unknown site>')}"
        for finding in findings
    ]
    return "refusing edit because local board SQL has no local-board head:\n" + "\n".join(details)


def main():
    return run_editor_tool_judge(
        guard_name="board-head-guard",
        subject="orchestrator",
        subcommand=["gate", "board-head", "judge"],
        timeout_seconds=JUDGE_TIMEOUT_SECONDS,
        precheck=should_check_board_head,
        denial_reason=refusal,
        backstop="bun scripts/check-hosted-local-sql.ts is the backstop",
    )


if __name__ == "__main__":
    raise SystemExit(main())
