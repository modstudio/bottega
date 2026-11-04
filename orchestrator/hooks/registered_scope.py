"""Adapt hook facts into the registered-scope decision."""
from __future__ import annotations

import os
import sqlite3
import sys

from registered_scope_decision import PROCESS_CWD, hook_acts, invocation_directory


def should_hook_act(payload: dict) -> bool:
    """Answer whether a product hook should act for this parsed payload."""
    global_use = os.environ.get("BOTTEGA_GLOBAL_USE")
    if global_use != "off":
        return True

    path = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
    if not path:
        print("bottega: registered scope store is unset: BOTTEGA_ORCHESTRATOR_DB", file=sys.stderr)
        return True
    try:
        database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = database.execute(
                "SELECT path FROM project WHERE retired_at IS NULL"
            ).fetchall()
        finally:
            database.close()
    except Exception as error:
        print(f"bottega: registered scope store could not be read at {path}: {error}", file=sys.stderr)
        return True

    env = dict(os.environ)
    env[PROCESS_CWD] = os.getcwd()
    directory = os.path.realpath(invocation_directory(payload, env))
    paths = [os.path.realpath(row[0]) for row in rows if isinstance(row[0], str)]
    return hook_acts(global_use, paths, directory)
