"""Pure policy for the main-checkout protection hook."""
import os


MUTATING_GIT_SUBCOMMANDS = {
    "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge",
    "rebase", "reset", "restore", "revert", "stash", "switch",
}


def decision_for_mutations(mutations, projects):
    """Decide whether normalized mutations target a protected registered main."""
    for mutation in mutations:
        target = mutation["target"]
        for project in projects:
            settings = project.get("settings") or {}
            if settings.get("requireCleanMain") is False:
                continue
            root = project.get("path") or ""
            worktrees = os.path.join(root, ".claude", "worktrees")
            in_root = target == root or target.startswith(root + os.sep)
            in_worktree = target.startswith(worktrees + os.sep)
            if in_root and not in_worktree:
                return {
                    "project": project,
                    "root": root,
                    "subcommand": mutation["subcommand"],
                }
    return None
