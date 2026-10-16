#!/usr/bin/env python3
"""Refuse hub source edits that violate the import architecture."""

import json
import os
import subprocess
import sys
import tempfile


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


def project_root(path):
    normalized = path.replace(os.sep, "/")
    markers = ("/hub/ui/", "/hub/web/src/")
    positions = [normalized.find(marker) for marker in markers]
    positions = [position for position in positions if position >= 0]
    if not positions:
        return None
    return normalized[: min(positions)]


def unchecked(file, reason):
    print(
        f"hub-import-guard: {file} was not checked: {reason}; the gate is the backstop",
        file=sys.stderr,
    )
    return 0


def replacement(source, edit):
    old = edit.get("old_string")
    new = edit.get("new_string")
    if not isinstance(old, str) or not isinstance(new, str) or old not in source:
        raise ValueError("edit strings do not describe the current file")
    if edit.get("replace_all"):
        return source.replace(old, new)
    return source.replace(old, new, 1)


def candidate_content(path, payload):
    tool_input = payload["tool_input"]
    tool_name = payload["tool_name"]
    if tool_name == "Write":
        content = tool_input.get("content")
        if not isinstance(content, str):
            raise ValueError("Write has no content")
        return content
    with open(path, encoding="utf-8") as source_file:
        content = source_file.read()
    if tool_name == "Edit":
        return replacement(content, tool_input)
    edits = tool_input.get("edits")
    if not isinstance(edits, list):
        raise ValueError("MultiEdit has no edits")
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError("MultiEdit contains an invalid edit")
        content = replacement(content, edit)
    return content


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
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        return unchecked("<unknown hub file>", f"invalid hook input ({error})")
    path = target_path(payload)
    root = project_root(path) if path is not None else None
    if root is None:
        return 0
    if payload.get("tool_name") not in EDITOR_TOOLS:
        return unchecked(path, "tool input is not a supported editor shape")
    judge = os.path.join(root, "scripts", "check-architecture-file.ts")
    if not os.path.isfile(judge):
        return unchecked(path, f"judge is missing ({judge})")
    try:
        candidate = candidate_content(path, payload)
    except (OSError, ValueError) as error:
        return unchecked(path, f"candidate could not be reconstructed ({error})")

    suffix = os.path.splitext(path)[1]
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", prefix=".architecture-guard-", suffix=suffix,
            dir=os.path.dirname(path), delete=False
        ) as candidate_file:
            candidate_file.write(candidate)
            temporary = candidate_file.name
        relative_candidate = os.path.relpath(temporary, root).replace(os.sep, "/")
        relative_original = os.path.relpath(path, root).replace(os.sep, "/")
        result = subprocess.run(
            ["bun", "--no-env-file", judge, relative_candidate, relative_original],
            cwd=root,
            capture_output=True,
            env=judge_environment(),
            text=True,
            timeout=JUDGE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return unchecked(path, f"judge timed out after {JUDGE_TIMEOUT_SECONDS} seconds")
    except OSError as error:
        return unchecked(path, f"judge could not start ({error})")
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass

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
    return unchecked(path, "judge returned no decision")


if __name__ == "__main__":
    raise SystemExit(main())
