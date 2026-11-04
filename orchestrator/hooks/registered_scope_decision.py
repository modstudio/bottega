"""Pure registered-scope decisions for product hooks."""
from __future__ import annotations

import os


PROCESS_CWD = "_BOTTEGA_HOOK_PROCESS_CWD"


def invocation_directory(payload: dict, env: dict[str, str]) -> str:
    """Choose the hook directory from plain invocation facts."""
    for key in ("CLAUDE_PROJECT_DIR", "GROK_WORKSPACE_ROOT"):
        value = env.get(key)
        if value:
            return value
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd
    return env[PROCESS_CWD]


def path_is_within(directory: str, root: str) -> bool:
    """Return whether directory is root or one of its descendants."""
    try:
        return os.path.commonpath((root, directory)) == root
    except ValueError:
        return False


def hook_acts(global_use: str | None, registered_paths: list[str] | None, directory: str) -> bool:
    """Return the scope decision; unknown facts preserve today's behavior."""
    if global_use != "off":
        return True
    if registered_paths is None:
        return True
    return any(path_is_within(directory, path) for path in registered_paths)
