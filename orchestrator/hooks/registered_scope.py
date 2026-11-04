"""Decide whether a product hook should act for this invocation."""
from __future__ import annotations

import os
import sqlite3
import sys
import tomllib


PLATFORM_SLUG = "BOTTEGA_CONFIG_HOME".removesuffix("_CONFIG_HOME").lower()


def _config_root() -> str:
    """Mirror shared/config-directory.ts:resolveConfigRoot for machineConfigPath."""
    override = os.environ.get("BOTTEGA_CONFIG_HOME")
    if override:
        if not os.path.isabs(override):
            raise ValueError("BOTTEGA_CONFIG_HOME must be absolute")
        return override
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg and os.path.isabs(xdg):
        return os.path.join(xdg, PLATFORM_SLUG)
    home = os.environ.get("HOME")
    if not home:
        raise ValueError("HOME is required")
    return os.path.join(home, ".config", PLATFORM_SLUG)


def _global_use_is_off() -> bool:
    try:
        with open(os.path.join(_config_root(), "machine.toml"), "rb") as handle:
            machine = tomllib.load(handle).get("machine")
        return isinstance(machine, dict) and machine.get("global_use") == "off"
    except Exception:
        return False


def _store_path() -> str:
    """Mirror shared/state-directory.ts:resolveStateRoot and resolveStatePaths."""
    configured = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
    if configured:
        return os.path.abspath(configured)
    state_home = os.environ.get("BOTTEGA_STATE_HOME")
    if state_home:
        if not os.path.isabs(state_home):
            raise ValueError("BOTTEGA_STATE_HOME must be absolute")
        root = state_home
    else:
        xdg = os.environ.get("XDG_STATE_HOME")
        if xdg and os.path.isabs(xdg):
            root = os.path.join(xdg, PLATFORM_SLUG)
        else:
            home = os.environ.get("HOME")
            if not home:
                raise ValueError("HOME is required")
            root = os.path.join(home, ".local", "state", PLATFORM_SLUG)
    return os.path.join(root, "orchestrator", "orchestrator.db")


def _invocation_directory(payload: dict) -> str:
    for key in ("CLAUDE_PROJECT_DIR", "GROK_WORKSPACE_ROOT"):
        value = os.environ.get(key)
        if value:
            return value
    cwd = payload.get("cwd")
    return cwd if isinstance(cwd, str) and cwd else os.getcwd()


def _contains(project_path: str, directory: str) -> bool:
    try:
        return os.path.commonpath((os.path.realpath(project_path), directory)) == os.path.realpath(
            project_path
        )
    except ValueError:
        return False


def should_hook_act(payload: dict) -> bool:
    """Answer whether a product hook should act for this parsed payload."""
    if not _global_use_is_off():
        return True

    try:
        path = _store_path()
    except Exception as error:
        print(f"{PLATFORM_SLUG}: registered scope store could not be resolved: {error}", file=sys.stderr)
        return False

    directory = os.path.realpath(_invocation_directory(payload))
    if not os.path.exists(path):
        print(f"{PLATFORM_SLUG}: registered scope store could not be read at {path}: file does not exist", file=sys.stderr)
        return False
    try:
        database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = database.execute("SELECT path FROM project").fetchall()
        finally:
            database.close()
    except Exception as error:
        print(f"{PLATFORM_SLUG}: registered scope store could not be read at {path}: {error}", file=sys.stderr)
        return False
    return any(isinstance(row[0], str) and _contains(row[0], directory) for row in rows)
