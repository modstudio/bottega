#!/usr/bin/env python3
"""Judge destructive pushes and allow selected git commands in throwaway worktrees.

A push that can destroy refs on a shared remote asks. Lease-guarded pushes and
deletions of ordinary named branches are allowed when they select no alternate
remote program. Other git commands are allowed only when their subcommand is on
a named list, they act beneath a registered project's worktree root, and they
carry no repository redirection or program-executing option. All others fall
through.
"""

import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WORKTREE_DIRECTORY = os.path.join(".claude", "worktrees")

# Destructive, but allowed when every target is an ordinary named branch.
SCOPED_FLAGS = ("--delete", "-d", "--force-if-includes")
# Destructive regardless of target.
BROAD_FLAGS = ("--force", "-f", "--mirror", "--prune", "--all", "--branches", "--tags")
# Push options that consume the following argument.
VALUE_OPTS = ("-o", "--push-option", "--repo", "--receive-pack", "--exec")

WORKTREE_SUBCOMMANDS = {
    "status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree",
    "cat-file", "rev-parse", "rev-list", "merge-base", "show-ref",
    "for-each-ref", "symbolic-ref", "name-rev", "describe", "reflog",
    "shortlog", "add", "rm", "mv", "restore", "commit", "switch",
    "checkout", "branch", "tag", "merge", "rebase", "cherry-pick", "revert",
    "reset", "stash", "clean", "apply", "am", "fetch", "pull", "worktree",
}
PUSH_PROGRAM_OPTIONS = ("--exec", "--receive-pack")
PROGRAM_EXECUTING_OPTIONS = (
    "-x", *PUSH_PROGRAM_OPTIONS, "--upload-pack", "-O",
    "--open-files-in-pager", "--ext-diff", "--output",
)

PROTECTED_BRANCHES = {
    "main", "master", "develop", "dev", "trunk",
    "staging", "stage", "production", "prod", "release", "HEAD",
}
PROTECTED_PREFIXES = ("release/", "releases/")
BRANCH_NAME = re.compile(r"^[A-Za-z0-9._/-]+$")

# Anything that could make the command do more than one thing, or reach a
# directory other than the one resolved below. A compound is left alone: the
# harness matches each of its segments against the permission rules already.
UNSAFE = ("&&", "||", ";", "|", "\n", "\r", "`", "$(", "${", ">", "<", "&")


def decide(decision, reason):
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
    )
    return 0


def database_path():
    """Resolve the orchestrator store without making hook failure restrictive."""
    if os.environ.get("ORCH_DB"):
        return os.environ["ORCH_DB"]
    try:
        result = subprocess.run(
            [
                "bun", "--no-env-file",
                os.path.join(ROOT, "shared", "state-directory.ts"),
                "orchestrator", "database",
            ],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def load_projects(db_path):
    """Read the registered checkout paths and settings, or fail open."""
    if not db_path or not os.path.exists(db_path):
        return None
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = connection.execute("SELECT name, path, settings FROM project").fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        return None
    projects = []
    for name, path, settings_raw in rows:
        settings = {}
        if settings_raw:
            try:
                parsed = json.loads(settings_raw)
                if isinstance(parsed, dict):
                    settings = parsed
            except (json.JSONDecodeError, TypeError):
                pass
        projects.append({"name": name, "path": path, "settings": settings})
    projects.sort(key=lambda row: len(row["path"] or ""), reverse=True)
    return projects


def git_invocation(payload):
    """Return argv and effective cwd for one unambiguous git invocation."""
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not isinstance(command, str) or not command.strip() or any(token in command for token in UNSAFE):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not argv:
        return None
    cwd = payload.get("cwd") or os.getcwd()
    # `orch workflow exec [flags] -- git ...` records the exit of the command
    # after `--`; judge that command in the directory exec will use.
    if (
        len(argv) > 3
        and os.path.basename(argv[0]) == "orch"
        and argv[1:3] == ["workflow", "exec"]
        and "--" in argv
    ):
        split = argv.index("--")
        flags, argv = argv[3:split], argv[split + 1:]
        cwd_values = []
        index = 0
        while index < len(flags):
            flag = flags[index]
            if flag == "--cwd":
                if index + 1 >= len(flags) or flags[index + 1].startswith("-"):
                    return None
                cwd_values.append(flags[index + 1])
                index += 2
                continue
            if flag.startswith("--cwd="):
                value = flag[len("--cwd="):]
                if not value:
                    return None
                cwd_values.append(value)
            index += 1
        if len(cwd_values) > 1:
            return None
        if cwd_values:
            cwd = cwd_values[0]
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    return argv, cwd


def command_directory(argv, cwd):
    """Resolve the directory the git invocation acts on, or None."""
    redirection_options = (
        "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
        "--exec-path", "--super-prefix",
    )
    index = 1
    while index < len(argv):
        arg = argv[index]
        if not arg.startswith("-"):
            break
        if arg == "--bare":
            return None
        if any(arg == option or arg.startswith(option + "=") for option in redirection_options):
            return None
        if arg == "-C":
            index += 2
            continue
        index += 1

    dash_c = [index for index, arg in enumerate(argv) if arg == "-C"]
    if len(dash_c) > 1:
        return None
    target = cwd
    if dash_c:
        index = dash_c[0] + 1
        if index >= len(argv):
            return None
        target = argv[index]
        if not os.path.isabs(target):
            target = os.path.join(cwd, target)
    try:
        resolved = os.path.realpath(os.path.expanduser(target))
    except (OSError, TypeError):
        return None
    return resolved if os.path.isdir(resolved) else None


def project_for(directory, projects):
    """Return the longest registered checkout containing the directory."""
    if directory is None:
        return None
    for project in projects:
        path = project.get("path")
        if not isinstance(path, str) or not path:
            continue
        root = os.path.realpath(path)
        if directory == root or directory.startswith(root + os.sep):
            return project, root
    return None


def protected_names(project):
    """Return conservative protected names plus the project's declared branches."""
    names = set(PROTECTED_BRANCHES)
    if project is None:
        return names
    settings = project.get("settings") or {}
    for key in ("trunk", "productionBranch"):
        value = settings.get(key)
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return names


def ordinary_branch(ref, protected):
    if ref.startswith("refs/heads/"):
        ref = ref[len("refs/heads/"):]
    elif ref.startswith("refs/"):
        return False
    if not BRANCH_NAME.match(ref):
        return False
    return ref not in protected and not ref.startswith(PROTECTED_PREFIXES)


def push_verdict(argv, protected):
    """Return safe or ask for a push that can destroy refs, else None."""
    head = argv[:argv.index("--")] if "--" in argv else argv
    if "push" not in head:
        return None
    args = head[head.index("push") + 1:]
    runs_remote_program = any(
        arg == option or arg.startswith(option + "=")
        for arg in args
        for option in PUSH_PROGRAM_OPTIONS
    )
    expanded = []
    for arg in args:
        if re.fullmatch(r"-[A-Za-z]{2,}", arg):
            last = len(arg) - 1
            expanded.extend(
                (f"-{letter}", letter == "o" and index == last)
                for index, letter in enumerate(arg[1:], start=1)
            )
        else:
            expanded.append((arg, arg == "-o"))
    args = expanded

    destructive = broad = False
    positional = []
    skip = False
    for arg, consumes_value in args:
        if skip:
            skip = False
        elif arg in VALUE_OPTS and (arg != "-o" or consumes_value):
            skip = True
        elif arg.startswith("--force-with-lease") or arg in SCOPED_FLAGS:
            destructive = True
        elif arg in BROAD_FLAGS or arg.startswith("--force"):
            destructive = broad = True
        elif not arg.startswith("-"):
            positional.append(arg)

    refspecs = positional[1:]
    for spec in refspecs:
        if spec.startswith("+"):
            destructive = broad = True
            spec = spec[1:]
        src, colon, dst = spec.rpartition(":")
        if colon and not src:
            destructive = True
        if not ordinary_branch(dst, protected):
            broad = True

    if not destructive:
        return None
    if broad or not refspecs:
        return "ask"
    if runs_remote_program:
        return None
    return "safe"


def git_subcommand(argv):
    """Return the git subcommand after global options and their values."""
    value_options = {
        "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
        "--exec-path", "--super-prefix",
    }
    index = 1
    while index < len(argv):
        arg = argv[index]
        if not arg.startswith("-"):
            return arg
        if arg in value_options:
            index += 2
        else:
            index += 1
    return None


def worktree_command_allowed(argv):
    """Whether the invocation is a listed command with no program option."""
    if git_subcommand(argv) not in WORKTREE_SUBCOMMANDS:
        return False
    return not any(
        arg == option or (option.startswith("--") and arg.startswith(option))
        for arg in argv[1:]
        for option in PROGRAM_EXECUTING_OPTIONS
    )


def is_throwaway_worktree(directory, worktree_root):
    """Whether the directory lies beneath the registered project's worktree root."""
    if directory is None or worktree_root is None:
        return False
    root = os.path.realpath(worktree_root)
    return directory != root and directory.startswith(root + os.sep)


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
            return 0
        invocation = git_invocation(payload)
        if invocation is None:
            return 0
        argv, cwd = invocation
        directory = command_directory(argv, cwd)
        projects = load_projects(database_path())
        if projects is None:
            return 0
        match = project_for(directory, projects)
        project, root = match if match is not None else (None, None)

        verdict = push_verdict(argv, protected_names(project))
        if verdict == "ask":
            return decide("ask", "push can destroy refs on the shared remote")
        if verdict == "safe":
            return decide("allow", "lease-guarded or feature-branch push")

        worktree_root = os.path.join(root, WORKTREE_DIRECTORY) if root else None
        if (
            is_throwaway_worktree(directory, worktree_root)
            and worktree_command_allowed(argv)
        ):
            return decide("allow", f"git confined to throwaway worktree {directory}")
        return 0
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
