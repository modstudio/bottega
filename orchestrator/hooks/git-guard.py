#!/usr/bin/env python3
"""Decide when a session may skip the permission prompt for a git command.

This hook is a convenience, not a sandbox. Git still runs whatever repository
configuration selects, including hooks, filters, editors, external diffs, and
signing programs. Worker runs are confined by the operating-system sandbox, not
by this hook.
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

# Each allowed worktree subcommand and the additional policy applied to it.
WORKTREE_COMMAND_POLICIES = {
    "status": {},
    "log": {"long": ("--textconv", "--ext-diff"), "long_prefix": ("--output",)},
    "show": {"long": ("--textconv", "--ext-diff"), "long_prefix": ("--output",)},
    "diff": {
        "long": ("--textconv", "--ext-diff", "--no-index"),
        "long_prefix": ("--output",),
    },
    "blame": {},
    "grep": {
        "short": "O",
        "long": ("--no-index",),
        "long_prefix": ("--open-files-in-pager",),
    },
    "ls-files": {},
    "ls-tree": {},
    "cat-file": {"long": ("--filters", "--textconv")},
    "rev-parse": {},
    "rev-list": {},
    "merge-base": {},
    "show-ref": {},
    "for-each-ref": {},
    "name-rev": {},
    "describe": {},
    "shortlog": {},
    "add": {},
    "rm": {},
    "mv": {},
    "restore": {},
    "commit": {},
    "clean": {},
    "reset": {},
    "revert": {},
    "cherry-pick": {},
    "am": {},
    "apply": {"long": ("--unsafe-paths", "--directory")},
    "switch": {"long": ("--ignore-other-worktrees",)},
    "checkout": {"long": ("--ignore-other-worktrees",)},
    "merge": {"short": "s", "long": ("--strategy",)},
    "rebase": {
        "short": "xis",
        "long": ("--exec", "--interactive", "--strategy"),
    },
    "branch": {
        "short": "dDfFmMcCu",
        "long": (
            "--delete", "--force", "--move", "--copy", "--edit-description",
            "--set-upstream-to", "--unset-upstream",
        ),
    },
    "stash": {"blocked_actions": ("clear", "drop")},
    "worktree": {"only_action": "list"},
    "fetch": {"fetch_or_pull": True},
    "pull": {"fetch_or_pull": True},
}
PUSH_PROGRAM_OPTIONS = ("--exec", "--receive-pack")
REMOTE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

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
    subcommand = git_subcommand_index(argv)
    if subcommand is None or argv[subcommand] != "push":
        return None
    args = argv[subcommand + 1:]
    runs_remote_program = False
    destructive = broad = False
    positional = []
    skip = False
    options = True
    for arg in args:
        if skip:
            skip = False
            continue
        if options and arg == "--":
            options = False
            continue
        if not options or not arg.startswith("-") or arg == "-":
            positional.append(arg)
            continue
        if any(arg == option or arg.startswith(option + "=") for option in PUSH_PROGRAM_OPTIONS):
            runs_remote_program = True
        if arg in VALUE_OPTS:
            skip = True
            continue
        if any(arg.startswith(option + "=") for option in VALUE_OPTS if option.startswith("--")):
            continue
        # -oVALUE is one push-option, not a cluster containing force/delete.
        if arg.startswith("-o"):
            continue
        if re.fullmatch(r"-[A-Za-z]{2,}", arg):
            letters = arg[1:]
            if "f" in letters:
                destructive = broad = True
            if "d" in letters:
                destructive = True
            if letters.endswith("o"):
                skip = True
            continue
        if arg.startswith("--force-with-lease") or arg in SCOPED_FLAGS:
            destructive = True
        elif arg in BROAD_FLAGS or arg.startswith("--force"):
            destructive = broad = True

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


def git_subcommand_index(argv):
    """Return the index of the git subcommand after global options."""
    value_options = {
        "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
        "--exec-path", "--super-prefix",
    }
    index = 1
    while index < len(argv):
        arg = argv[index]
        if not arg.startswith("-"):
            return index
        if arg in value_options:
            index += 2
        else:
            index += 1
    return None


def git_subcommand(argv):
    """Return the git subcommand after global options and their values."""
    index = git_subcommand_index(argv)
    return argv[index] if index is not None else None


def has_long_option(args, *options, prefix=False):
    """Whether args contain a named long option, including its equals form."""
    return any(
        arg == option or arg.startswith(option if prefix else option + "=")
        for arg in args
        for option in options
    )


def has_short_option(args, letters):
    """Whether a short option appears alone, stuck to a value, or clustered."""
    return any(
        len(arg) >= 2 and arg.startswith("-") and not arg.startswith("--")
        and any(letter in arg[1:] for letter in letters)
        for arg in args
    )


def command_positionals(args, short_value_options=()):
    """Return operands while skipping common fetch and pull option values."""
    value_options = {
        "--depth", "--deepen", "--shallow-since", "--shallow-exclude",
        "--jobs", "--server-option", "--negotiation-tip", "--refmap",
        "--recurse-submodules", "--submodule-prefix", "--upload-pack",
        "--strategy", "--strategy-option", "--cleanup", "--gpg-sign",
    }
    positionals = []
    skip = False
    options = True
    for arg in args:
        if skip:
            skip = False
        elif options and arg == "--":
            options = False
        elif options and arg in value_options:
            skip = True
        elif options and arg in short_value_options:
            skip = True
        elif options and arg.startswith("-"):
            continue
        else:
            positionals.append(arg)
    return positionals


def worktree_command_allowed(argv):
    """Whether the invocation satisfies its subcommand's worktree policy."""
    index = git_subcommand_index(argv)
    if index is None:
        return False
    policy = WORKTREE_COMMAND_POLICIES.get(argv[index])
    if policy is None:
        return False
    args = argv[index + 1:]
    if has_short_option(args, policy.get("short", "")):
        return False
    if has_long_option(args, *policy.get("long", ())):
        return False
    if has_long_option(args, *policy.get("long_prefix", ()), prefix=True):
        return False
    if "blocked_actions" in policy:
        positionals = command_positionals(args)
        return not positionals or positionals[0] not in policy["blocked_actions"]
    if "only_action" in policy:
        positionals = command_positionals(args)
        return bool(positionals) and positionals[0] == policy["only_action"]
    if policy.get("fetch_or_pull"):
        if has_long_option(args, "--upload-pack", prefix=True):
            return False
        if has_long_option(args, "--update-head-ok"):
            return False
        recurse = [arg for arg in args if arg.startswith("--recurse-submodules")]
        if any(arg != "--recurse-submodules=no" for arg in recurse):
            return False
        positionals = command_positionals(
            args, short_value_options=("-j", "-o", "-u", "-s", "-X", "-S"),
        )
        if not positionals:
            return True
        if "--multiple" in args:
            return all(REMOTE_NAME.fullmatch(remote) for remote in positionals)
        remote, *refspecs = positionals
        return bool(REMOTE_NAME.fullmatch(remote)) and not any(
            refspec.startswith("+") or ":" in refspec for refspec in refspecs
        )
    return True


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
