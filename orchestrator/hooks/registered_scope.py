"""Decide whether a Bottega product hook should act for this invocation."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tomllib


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))


def _config_root() -> str:
    """Mirror shared/config-directory.ts:resolveConfigRoot for machineConfigPath."""
    override = os.environ.get("BOTTEGA_CONFIG_HOME")
    if override:
        if not os.path.isabs(override):
            raise ValueError("BOTTEGA_CONFIG_HOME must be absolute")
        return override
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg and os.path.isabs(xdg):
        return os.path.join(xdg, "bottega")
    home = os.environ.get("HOME")
    if not home:
        raise ValueError("HOME is required")
    return os.path.join(home, ".config", "bottega")


def _global_use_is_off() -> bool:
    try:
        with open(os.path.join(_config_root(), "machine.toml"), "rb") as handle:
            machine = tomllib.load(handle).get("machine")
        return isinstance(machine, dict) and machine.get("global_use") == "off"
    except Exception:
        return False


def _store_path() -> str:
    configured = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
    if configured:
        return os.path.abspath(configured)
    return subprocess.check_output(
        [
            "bun",
            "--no-env-file",
            os.path.join(ROOT, "shared", "state-directory.ts"),
            "orchestrator",
            "database",
        ],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


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
    """Answer whether a Bottega hook should act for this parsed payload."""
    if not _global_use_is_off():
        return True

    try:
        path = _store_path()
    except Exception as error:
        print(f"bottega: registered scope store could not be resolved: {error}", file=sys.stderr)
        return False

    directory = os.path.realpath(_invocation_directory(payload))
    try:
        database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = database.execute("SELECT path FROM project").fetchall()
        finally:
            database.close()
    except Exception as error:
        print(f"bottega: registered scope store could not be read at {path}: {error}", file=sys.stderr)
        return False
    return any(isinstance(row[0], str) and _contains(row[0], directory) for row in rows)
