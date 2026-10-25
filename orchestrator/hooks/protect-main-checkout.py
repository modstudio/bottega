#!/usr/bin/env python3
"""Refuse edits and mutating Git commands in a registered main checkout.

The default PreToolUse mode watches tracked-file edits and recognized mutating
Git subcommands from Bash. The --pre-commit mode watches commits from the
checkout itself. A project opts out with {"requireCleanMain": false} in its
register settings. Commands the Bash adapter cannot parse fail open, including
shell interpreter (`sh`/`bash`/`zsh -c`), `xargs`, and `eval` invocations.
"""
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys

from protect_main_checkout import (
    MUTATING_GIT_SUBCOMMANDS,
    decision_for_mutations,
    requires_clean_main,
)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
EDITOR_TOOLS = {"Write", "Edit", "NotebookEdit"}
INVARIANT = "A registered main checkout stays clean; work happens in a worktree"
GIT_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])git(?![A-Za-z0-9_-])")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def real(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def fail_open(message=None) -> int:
    if message:
        print(f"protect-main-checkout: allowing commit: {message}", file=sys.stderr)
    return 0


def database_path():
    configured = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
    if configured:
        return configured
    try:
        return subprocess.check_output(
            [
                "bun", "--no-env-file",
                os.path.join(ROOT, "shared", "state-directory.ts"),
                "orchestrator", "database",
            ],
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


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
    env.pop("BOTTEGA_GUARDED_GIT_COMMON_DIR", None)
    env.pop("BOTTEGA_ALLOWED_GIT_REF", None)
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


def split_assignments(tokens):
    index = 0
    while index < len(tokens) and ASSIGNMENT.match(tokens[index]):
        index += 1
    assignments = {}
    for word in tokens[:index]:
        name, value = word.split("=", 1)
        assignments[name] = value
    return assignments, tokens[index:]


def unwrap_command(tokens):
    """Strip transparent command wrappers, retaining leading assignments."""
    assignments = {}
    remaining = tokens
    while remaining:
        leading, remaining = split_assignments(remaining)
        assignments.update(leading)
        if not remaining:
            return None
        command = os.path.basename(remaining[0])
        if command in {"eval", "xargs"}:
            return None
        if command in {"sh", "bash", "zsh"} and "-c" in remaining[1:]:
            return None
        if command == "env":
            remaining = remaining[1:]
            while remaining and remaining[0].startswith("-"):
                remaining = remaining[1:]
            continue
        if command == "command":
            remaining = remaining[1:]
            continue
        if command == "nice":
            remaining = remaining[1:]
            if remaining[:1] == ["-n"]:
                if len(remaining) < 2:
                    return None
                remaining = remaining[2:]
            continue
        if command == "timeout":
            if len(remaining) < 3:
                return None
            remaining = remaining[2:]
            continue
        return assignments, remaining
    return None


def simple_commands(command, cwd):
    """Adapt shell text into command words and normalized effective cwd."""
    if not isinstance(command, str) or not isinstance(cwd, str):
        return None
    if "$(" in command or "`" in command or "\n" in command:
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        words = list(lexer)
    except (ValueError, TypeError):
        return None
    if any(word in {"(", ")"} for word in words):
        return None

    commands = []
    words_for_command = []
    effective_cwd = real(cwd)
    index = 0
    while index <= len(words):
        word = words[index] if index < len(words) else None
        if word and (">" in word or "<" in word):
            if words_for_command and words_for_command[-1].isdigit():
                words_for_command.pop()
            index += 2
            continue
        if word is not None and word not in {"&&", "||", ";", "|", "&"}:
            words_for_command.append(word)
            index += 1
            continue
        if words_for_command:
            unwrapped = unwrap_command(words_for_command)
            if unwrapped is None:
                return None
            assignments, executable = unwrapped
            if executable[0] == "cd":
                if word != "&&" or len(executable) != 2:
                    return None
                destination = os.path.expanduser(executable[1])
                effective_cwd = real(
                    destination if os.path.isabs(destination)
                    else os.path.join(effective_cwd, destination)
                )
            else:
                commands.append((executable, effective_cwd, assignments))
        words_for_command = []
        index += 1
    return commands


def resolve_git_path(path, cwd):
    expanded = os.path.expanduser(path)
    return real(expanded if os.path.isabs(expanded) else os.path.join(cwd, expanded))


def git_invocation(tokens, cwd, assignments):
    if not tokens or os.path.basename(tokens[0]) != "git":
        return None
    target = real(cwd)
    additional_targets = []
    index = 1
    options_with_values = {"-c", "--config-env", "--exec-path", "--namespace"}
    while index < len(tokens):
        word = tokens[index]
        if word == "-C":
            if index + 1 >= len(tokens):
                return None
            target = resolve_git_path(tokens[index + 1], target)
            index += 2
            continue
        if word.startswith("-C") and word != "-C":
            target = resolve_git_path(word[2:], target)
            index += 1
            continue
        if word in {"--git-dir", "--work-tree"}:
            if index + 1 >= len(tokens):
                return None
            resolved = resolve_git_path(tokens[index + 1], target)
            if word == "--git-dir":
                additional_targets.append(real(os.path.dirname(resolved)))
            else:
                additional_targets.append(resolved)
            index += 2
            continue
        if word.startswith("--git-dir="):
            resolved = resolve_git_path(word.split("=", 1)[1], target)
            additional_targets.append(real(os.path.dirname(resolved)))
            index += 1
            continue
        if word.startswith("--work-tree="):
            additional_targets.append(resolve_git_path(word.split("=", 1)[1], target))
            index += 1
            continue
        if word in options_with_values:
            if index + 1 >= len(tokens):
                return None
            index += 2
            continue
        if any(word.startswith(option + "=") for option in options_with_values if option.startswith("--")):
            index += 1
            continue
        if word == "--":
            index += 1
            break
        if word.startswith("-"):
            index += 1
            continue
        break
    if index >= len(tokens):
        return None
    if assignments.get("GIT_DIR"):
        git_dir = resolve_git_path(assignments["GIT_DIR"], target)
        additional_targets.append(real(os.path.dirname(git_dir)))
    if assignments.get("GIT_WORK_TREE"):
        additional_targets.append(resolve_git_path(assignments["GIT_WORK_TREE"], target))
    targets = [target, *additional_targets]
    return {"subcommand": tokens[index], "targets": list(dict.fromkeys(targets))}


def candidate_git_mutations(command, cwd):
    if not isinstance(command, str) or not GIT_TOKEN.search(command):
        return []
    commands = simple_commands(command, cwd)
    if commands is None:
        return None
    mutations = []
    for tokens, command_cwd, assignments in commands:
        invocation = git_invocation(tokens, command_cwd, assignments)
        if invocation and invocation["subcommand"] in MUTATING_GIT_SUBCOMMANDS:
            mutations.extend(
                {"subcommand": invocation["subcommand"], "target": target}
                for target in invocation["targets"]
            )
    return mutations


def normalized_projects(projects):
    return [{**project, "path": real(project.get("path") or "")} for project in projects]


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
                f"cleared by: bottega run start --cwd {shell_quote(hint + '/<tree>')}"
            ),
        }
    }))
    return 0


def deny_git_mutation(decision):
    project = decision["project"]
    root = decision["root"]
    subcommand = decision["subcommand"]
    hint = os.path.join(project["path"], ".claude", "worktrees")
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"{project['name']}: refusing git {subcommand} in registered main checkout {root}\n"
                f"run it from a worktree under {hint} instead\n"
                f"invariant: {INVARIANT}\n"
                f"cleared by: bottega run start --cwd {shell_quote(hint + '/<tree>')}"
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
    projects, error = load_projects_result(database_path())
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
    tool_name = payload.get("tool_name")
    if tool_name == "Bash":
        inp = payload.get("tool_input") or {}
        command = inp.get("command")
        cwd = payload.get("cwd")
        mutations = candidate_git_mutations(command, cwd)
        if not mutations:
            return fail_open()
        projects, error = load_projects_result(database_path())
        if error:
            return fail_open(error)
        projects = normalized_projects(projects)
        decision = decision_for_mutations(mutations, projects)
        return deny_git_mutation(decision) if decision else fail_open()
    if tool_name not in EDITOR_TOOLS:
        return fail_open()
    path = target_path(payload)
    if not path:
        return fail_open()
    path = real(path)
    projects = load_projects(database_path())
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
