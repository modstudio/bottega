"""Pure Bash-command policy for the main-checkout protection hook."""
import os
import re
import shlex


MUTATING_GIT_SUBCOMMANDS = {
    "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge",
    "rebase", "reset", "restore", "revert", "stash", "switch",
}
GIT_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])git(?![A-Za-z0-9_-])")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def real(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def without_assignments(tokens):
    index = 0
    while index < len(tokens) and ASSIGNMENT.match(tokens[index]):
        index += 1
    return tokens[index:]


def simple_commands(command, cwd):
    """Return shell words with their effective cwd, or None when unsure."""
    if not isinstance(command, str) or not isinstance(cwd, str):
        return None
    if "$(" in command or "`" in command or "\n" in command:
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        words = list(lexer)
    except (ValueError, TypeError):
        return None
    if any(word in {"(", ")", "&"} for word in words):
        return None

    commands = []
    words_for_command = []
    effective_cwd = cwd
    for word in [*words, None]:
        if word is not None and word not in {"&&", "||", ";", "|"}:
            words_for_command.append(word)
            continue
        if not words_for_command:
            if word is None and commands:
                break
            return None
        executable = without_assignments(words_for_command)
        if not executable:
            return None
        if executable[0] == "eval" or (
            os.path.basename(executable[0]) == "bash" and "-c" in executable[1:]
        ):
            return None
        if executable[0] == "cd":
            if word != "&&" or len(executable) != 2:
                return None
            destination = os.path.expanduser(executable[1])
            effective_cwd = real(
                destination if os.path.isabs(destination)
                else os.path.join(effective_cwd, destination)
            )
        else:
            commands.append((executable, effective_cwd))
        words_for_command = []
    return commands


def git_invocation(tokens, cwd):
    if not tokens or os.path.basename(tokens[0]) != "git":
        return None
    target = cwd
    index = 1
    options_with_values = {
        "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree", "--namespace",
    }
    while index < len(tokens):
        word = tokens[index]
        if word == "-C":
            if index + 1 >= len(tokens):
                return None
            path = os.path.expanduser(tokens[index + 1])
            target = path if os.path.isabs(path) else os.path.join(target, path)
            index += 2
            continue
        if word.startswith("-C") and word != "-C":
            path = os.path.expanduser(word[2:])
            target = path if os.path.isabs(path) else os.path.join(target, path)
            index += 1
            continue
        if word in options_with_values:
            if index + 1 >= len(tokens):
                return None
            index += 2
            continue
        if any(
            word.startswith(option + "=")
            for option in options_with_values
            if option.startswith("--")
        ):
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
    return {"subcommand": tokens[index], "target": real(target)}


def candidate_git_mutations(command, cwd):
    if not isinstance(command, str) or not GIT_TOKEN.search(command):
        return []
    commands = simple_commands(command, cwd)
    if commands is None:
        return None
    mutations = []
    for tokens, command_cwd in commands:
        invocation = git_invocation(tokens, command_cwd)
        if invocation and invocation["subcommand"] in MUTATING_GIT_SUBCOMMANDS:
            mutations.append(invocation)
    return mutations


def decision_for_command(command, cwd, projects):
    """Decide whether a parsed mutation targets a protected registered main."""
    mutations = candidate_git_mutations(command, cwd)
    if not mutations:
        return None
    for mutation in mutations:
        target = mutation["target"]
        for project in projects:
            settings = project.get("settings") or {}
            if settings.get("requireCleanMain") is False:
                continue
            root = real(project.get("path") or "")
            worktrees = os.path.join(root, ".claude", "worktrees")
            in_root = target == root or target.startswith(root + os.sep)
            in_worktree = target == worktrees or target.startswith(worktrees + os.sep)
            if in_root and not in_worktree:
                return {
                    "project": project,
                    "root": root,
                    "subcommand": mutation["subcommand"],
                }
    return None
