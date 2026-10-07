"""Shared standard-library helpers for acknowledgement-required board hooks."""
from __future__ import annotations

import json
import os
import subprocess


def store_path() -> str:
    return os.path.abspath(os.environ["ORCH_DB"])


def pending(session: str, all_notices: bool = False):
    binary = os.environ.get("ORCH_BOARD_BIN") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch")
    )
    command = [binary, "board", "pending", "--session", session, "--json"]
    if all_notices:
        command.append("--all")
    timeout = float(os.environ["BOARD_PUSH_SLOW_TIMEOUT_SECONDS"])
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    value = json.loads(result.stdout)
    notices = value.get("notices")
    if not isinstance(notices, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("id"), str)
        or not isinstance(item.get("text"), str)
        for item in notices
    ):
        raise ValueError("malformed board pending output")
    return notices
