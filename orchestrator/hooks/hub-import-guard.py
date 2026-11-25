#!/usr/bin/env python3
"""Refuse hub source edits that violate the import architecture."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from editor_tool_judge import EDITOR_TOOLS, UnsupportedEditorShape, run_editor_tool_judge
from registered_scope import should_hook_act

JUDGE_TIMEOUT_SECONDS = 8


def should_check_hub_import(payload, path):
    if not should_hook_act(payload):
        return False
    if path is None or "/hub/" not in path.replace(os.sep, "/"):
        return False
    if payload.get("tool_name") not in EDITOR_TOOLS:
        raise UnsupportedEditorShape("tool input is not a supported editor shape")
    return True


def refusal(findings):
    details = [
        f"{finding.get('rule', '<unknown rule>')}: {finding.get('dependency', '<unknown import>')}"
        for finding in findings
    ]
    return "refusing hub edit because it violates an import boundary:\n" + "\n".join(details)


def main():
    return run_editor_tool_judge(
        guard_name="hub-import-guard",
        subject="hub",
        subcommand=["gate", "hub-import", "judge"],
        timeout_seconds=JUDGE_TIMEOUT_SECONDS,
        precheck=should_check_hub_import,
        denial_reason=refusal,
        backstop="the gate is the backstop",
        deadline=True,
    )


if __name__ == "__main__":
    raise SystemExit(main())
