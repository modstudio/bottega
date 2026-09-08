#!/usr/bin/env python3
"""PreToolUse hook: refuse an edit to a TRACKED file in a registered main checkout.

Landings, orch itself and ordinary builds are not gated — they do not go
through the interactive editor tools this watches. A project opts out with
{"requireCleanMain": false} in its register settings.
"""
import json
import os
import sqlite3
import subprocess
import sys

EDITOR_TOOLS = {"Write", "Edit", "NotebookEdit"}
INVARIANT = "A registered main checkout stays clean; work happens in a worktree"


def fail_open() -> int:
    return 0


def git(args, cwd):
    env = os.environ.copy()
    for key in list(env):
        if key == "GIT_DIR" or key == "GIT_WORK_TREE" or key == "GIT_OBJECT_DIRECTORY" \
                or key == "GIT_ALTERNATE_OBJECT_DIRECTORIES" or key == "GIT_CONFIG_COUNT" \
                or key.startswith("GIT_CONFIG_KEY_") or key.startswith("GIT_CONFIG_VALUE_") \
                or key in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
                           "ORCH_GUARDED_GIT_COMMON_DIR", "ORCH_ALLOWED_GIT_REF"):
            env.pop(key, None)
    try:
        return subprocess.run(
            ["git", "--no-optional-locks", *args],
            cwd=cwd, env=env, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def real(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def load_projects(db_path):
    if not db_path or not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute("SELECT name, path, settings FROM project").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    projects = []
    for name, path, settings_raw in rows:
        settings = {}
        if settings_raw:
            try:
                parsed = json.loads(settings_raw)
                if isinstance(parsed, dict):
                    settings = parsed
            except json.JSONDecodeError:
                settings = {}
        projects.append({"name": name, "path": path, "settings": settings})
    projects.sort(key=lambda row: len(row["path"] or ""), reverse=True)
    return projects


def requires_clean_main(settings):
    return settings.get("requireCleanMain") is not False


def target_path(payload):
    inp = payload.get("tool_input") or {}
    raw = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
    if not raw or not isinstance(raw, str):
        return None
    path = os.path.expanduser(raw)
    if os.path.isabs(path):
        return path
    cwd = payload.get("cwd") or os.getcwd()
    return os.path.join(cwd, path)


def project_for(path, projects):
    resolved = real(path)
    for project in projects:
        root = real(project["path"])
        if resolved == root or resolved.startswith(root + os.sep):
            return project, root
    return None, None


def toplevel(path):
    directory = path if os.path.isdir(path) else os.path.dirname(path)
    if not directory:
        return None
    result = git(["rev-parse", "--path-format=absolute", "--show-toplevel"], directory)
    if result is None or result.returncode != 0:
        return None
    return result.stdout.strip()


def tracked_in_main(root, path):
    rel = os.path.relpath(real(path), root)
    if rel.startswith(".."):
        return False
    result = git(["ls-files", "--error-unmatch", "--", rel], root)
    return result is not None and result.returncode == 0


def shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


def deny(project, path):
    hint = os.path.join(project["path"], ".claude", "worktrees")
    rel = os.path.relpath(path, project["path"])
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"{project['name']}: refusing edit to tracked file {rel} in main checkout {project['path']}\n"
                f"work from a worktree under {hint} instead\n"
                f"invariant: {INVARIANT}\n"
                f"cleared by: orch do --cwd {shell_quote(hint + '/<tree>')}"
            ),
        }
    }))
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return fail_open()
    if payload.get("tool_name") not in EDITOR_TOOLS:
        return fail_open()
    path = target_path(payload)
    if not path:
        return fail_open()
    path = real(path)
    db_path = os.environ.get("ORCH_DB") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "orch.db"
    )
    projects = load_projects(db_path)
    project, root = project_for(path, projects)
    if project is None or root is None:
        return fail_open()
    if not requires_clean_main(project["settings"]):
        return fail_open()
    top = toplevel(path)
    if not top or real(top) != root:
        return fail_open()
    if not tracked_in_main(root, path):
        return fail_open()
    return deny(project, path)


if __name__ == "__main__":
    sys.exit(main())
