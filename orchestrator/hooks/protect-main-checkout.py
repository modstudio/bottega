#!/usr/bin/env python3
"""Refuse edits and commits in a registered main checkout.

The default PreToolUse mode watches tracked-file edits. The --pre-commit mode
watches commits from the checkout itself. A project opts out with
{"requireCleanMain": false} in its register settings.
"""
import json
import os
import sqlite3
import subprocess
import sys


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
DB_PATH = os.environ.get("ORCH_DB") or subprocess.check_output(
    ["bun", "--no-env-file", os.path.join(ROOT, "shared", "state-directory.ts"), "orchestrator", "database"],
    text=True,
).strip()

EDITOR_TOOLS = {"Write", "Edit", "NotebookEdit"}
INVARIANT = "A registered main checkout stays clean; work happens in a worktree"


def fail_open(message=None) -> int:
    if message:
        print(f"protect-main-checkout: allowing commit: {message}", file=sys.stderr)
    return 0


def git(args, cwd):
    """Hermetic git: ask git which GIT_* are local, rather than maintaining a list.

    Duplicating this call (the same mechanism as shared/git.ts) is not a
    defect; duplicating a list of variable names is. Git supplies the names.
    This hook and dispatch ask different questions and share invocation, not
    a cleanliness verdict.
    """
    env = os.environ.copy()
    try:
        listed = subprocess.run(
            ["git", "rev-parse", "--local-env-vars"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if listed.returncode != 0:
        return None
    for key in listed.stdout.split():
        env.pop(key, None)
    env.pop("ORCH_GUARDED_GIT_COMMON_DIR", None)
    env.pop("ORCH_ALLOWED_GIT_REF", None)
    # Inspection must not pick up a worker GIT_CONFIG_GLOBAL; git excludes
    # that name from --local-env-vars (it is global-behavior).
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
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


def load_projects_result(db_path):
    if not db_path or not os.path.exists(db_path):
        return [], "project register is missing"
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute("SELECT name, path, settings FROM project").fetchall()
        finally:
            conn.close()
    except sqlite3.Error as error:
        return [], f"project register is unreadable ({error})"
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
    return projects, None


def load_projects(db_path):
    return load_projects_result(db_path)[0]


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


def deny_commit(project):
    hint = os.path.join(project["path"], ".claude", "worktrees")
    print(
        f"{project['name']}: refusing commit in registered main checkout {project['path']}",
        file=sys.stderr,
    )
    print(f"invariant: {INVARIANT}", file=sys.stderr)
    print(f"cleared by: commit from a worktree under {hint}", file=sys.stderr)
    return 1


def pre_commit() -> int:
    cwd = os.getcwd()
    projects, error = load_projects_result(DB_PATH)
    if error:
        return fail_open(error)
    top = toplevel(cwd)
    if not top:
        return fail_open("git could not resolve the checkout")
    project, root = project_for(top, projects)
    if project is None or root is None:
        return fail_open()
    if not requires_clean_main(project["settings"]):
        return fail_open()
    if real(top) != root:
        return fail_open()
    return deny_commit(project)


def main() -> int:
    if sys.argv[1:] == ["--pre-commit"]:
        return pre_commit()
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
    projects = load_projects(DB_PATH)
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
