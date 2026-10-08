"""Shared standard-library helpers for board delivery and acknowledgement hooks."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess


def store_path() -> str:
    return os.path.abspath(os.environ["ORCH_DB"])


def marker_path(kind: str, session: str) -> str:
    root = os.path.abspath(os.environ["ORCH_BOARD_HOOK_STATE"])
    name = hashlib.sha256(session.encode()).hexdigest()
    return os.path.join(root, kind, name)


def read_marker(path: str):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return None
            with os.fdopen(descriptor, encoding="utf-8") as handle:
                descriptor = -1
                return json.load(handle)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
    except FileNotFoundError:
        return {}
    except Exception:
        return None


def write_marker(path: str, value) -> bool:
    try:
        base = os.path.abspath(os.environ["ORCH_BOARD_HOOK_STATE"])
        os.makedirs(base, mode=0o700, exist_ok=True)
        os.chmod(base, 0o700, follow_symlinks=False)
        root = os.path.dirname(path)
        os.makedirs(root, mode=0o700, exist_ok=True)
        os.chmod(root, 0o700, follow_symlinks=False)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_NONBLOCK
        descriptor = os.open(path, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return False
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                descriptor = -1
                json.dump(value, handle)
            return True
        finally:
            if descriptor >= 0:
                os.close(descriptor)
    except Exception:
        return False


def pending(session: str, recently_injected: list[str] | None = None):
    binary = os.environ.get("ORCH_BOARD_BIN") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch")
    )
    command = [binary, "board", "pending", "--session", session, "--json"]
    if recently_injected:
        command.extend(["--recently-injected", ",".join(recently_injected)])
    timeout = float(os.environ["BOARD_PUSH_SLOW_TIMEOUT_SECONDS"])
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    value = json.loads(result.stdout)
    delivery = value.get("delivery")
    acknowledgements = value.get("pendingAcknowledgements")
    if not isinstance(delivery, list) or not isinstance(acknowledgements, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("id"), str)
        or not isinstance(item.get("text"), str)
        or not isinstance(item.get("requiresAcknowledgement"), bool)
        for item in [*delivery, *acknowledgements]
    ):
        raise ValueError("malformed board pending output")
    overflow = value.get("overflow")
    if overflow is not None and not isinstance(overflow, str):
        raise ValueError("malformed board pending output")
    return delivery, overflow, acknowledgements


def mark_delivered(session: str, ids: list[str]) -> None:
    if not ids:
        return
    binary = os.environ.get("ORCH_BOARD_BIN") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch")
    )
    command = [binary, "board", "delivered", ",".join(ids), "--session", session]
    subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=float(os.environ["BOARD_PUSH_SLOW_TIMEOUT_SECONDS"]),
        check=True,
    )
