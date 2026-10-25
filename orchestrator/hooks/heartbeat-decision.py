#!/usr/bin/env python3
"""Pure heartbeat presentation decisions used by the shell adapter.

Tick exits with HEARTBEAT_KEEP_LOOP_EXIT_STATUS while watching must continue and
HEARTBEAT_CLEAR_EXIT_STATUS only for CLEAR, when the shell should stop watching.
"""

import re
import os
import sys
import base64
import binascii
import json
import datetime
from enum import Enum, auto
from typing import NamedTuple

from inbox_question_decision import decide_inbox_questions

NOTICE_REASON_MAX_BYTES = 4096
NOTICE_REASON_MAX_CHARS = 240
HEARTBEAT_KEEP_LOOP_EXIT_STATUS = 0
HEARTBEAT_CLEAR_EXIT_STATUS = 10

SECRET_ASSIGNMENT = re.compile(r"\b(?:token|key|secret|password)\s*=\s*\S+", re.IGNORECASE)
SECRET_BEARER = re.compile(r"\bBearer\s+\S+", re.IGNORECASE)
SECRET_AUTHORIZATION = re.compile(r"\bAuthorization\s*[:=]\s*\S+", re.IGNORECASE)
SECRET_TOKEN_PREFIX = re.compile(
    r"(?<![A-Za-z0-9])(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xox[bposa]-|AKIA)"
)
SECRET_HEX_RUN = re.compile(r"[0-9a-fA-F]{32,}")
SECRET_URL_USERINFO = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@")
SECRET_PEM_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
SECRET_JWT = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
SECRET_BASE64_RUN = re.compile(r"[A-Za-z0-9+_-]{27,}={0,2}")


def _jwt_header_is_object(token: str) -> bool:
    try:
        header = token.split(".", 1)[0]
        padded = header + "=" * ((4 - len(header) % 4) % 4)
        parsed = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        return isinstance(parsed, dict)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def _base64_run_is_secret(run: str) -> bool:
    try:
        normalized = run.replace("-", "+").replace("_", "/")
        padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
        decoded = base64.b64decode(padded, validate=True)
        if base64.b64encode(decoded).decode("ascii").rstrip("=") != padded.rstrip("="):
            return False
    except (ValueError, binascii.Error):
        return False
    return len(decoded) >= 20 and (
        bool(re.search(r"[+=]", run))
        or (bool(re.search(r"[a-z]", run)) and bool(re.search(r"[A-Z]", run)) and bool(re.search(r"\d", run)))
    )


def contains_secret_shaped(text: str) -> bool:
    return bool(
        SECRET_AUTHORIZATION.search(text)
        or SECRET_BEARER.search(text)
        or SECRET_ASSIGNMENT.search(text)
        or SECRET_TOKEN_PREFIX.search(text)
        or SECRET_HEX_RUN.search(text)
        or SECRET_URL_USERINFO.search(text)
        or SECRET_PEM_PRIVATE_KEY.search(text)
        or any(_jwt_header_is_object(match.group(0)) for match in SECRET_JWT.finditer(text))
        or any(_base64_run_is_secret(match.group(0)) for match in SECRET_BASE64_RUN.finditer(text))
    )


class HeartbeatDecision(NamedTuple):
    lines: list[str]
    should_exit: bool


class HeartbeatState(Enum):
    BLOCKED = auto()
    BLOCKED_STALLED = auto()
    STALLED = auto()
    WAITING = auto()
    CLEAR = auto()


def _timestamp(value: str) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def open_board_requests(
    roots: list[dict], replies: list[dict], author_session: str, now: float
) -> list[dict]:
    """Return authored request roots still waiting for a delivered external reply."""
    answered = {
        reply.get("root_id")
        for reply in replies
        if reply.get("author_session") != author_session and reply.get("delivered_at")
    }
    open_roots = []
    for root in roots:
        if root.get("kind") != "question" and root.get("purpose") != "request":
            continue
        expires_at = root.get("expires_at")
        if (
            not isinstance(expires_at, str)
            or root.get("withdrawn_at") is not None
            or _timestamp(expires_at) <= now
            or root.get("id") in answered
        ):
            continue
        open_roots.append(root)
    return sorted(open_roots, key=lambda root: str(root.get("id")))


def heartbeat_decision(
    timestamp: str,
    inbox: list[dict],
    run_count: int,
    landing_count: int,
    stalled_count: int,
    stalled_detail: str,
    waiting_detail: str,
    open_request_count: int = 0,
    open_request_detail: str = "",
) -> HeartbeatDecision:
    product = "bottega"
    lines = []
    inbox_decision = decide_inbox_questions(inbox)
    asking = inbox_decision.answerable_now
    if asking > 0 and stalled_count > 0:
        state = HeartbeatState.BLOCKED_STALLED
    elif asking > 0:
        state = HeartbeatState.BLOCKED
    elif stalled_count > 0:
        state = HeartbeatState.STALLED
    elif (
        run_count > 0
        or landing_count > 0
        or inbox_decision.parked_here > 0
        or open_request_count > 0
    ):
        state = HeartbeatState.WAITING
    else:
        state = HeartbeatState.CLEAR

    if state in (HeartbeatState.BLOCKED, HeartbeatState.BLOCKED_STALLED):
        lines.append(
            f"[{timestamp}] BLOCKED - {asking} question(s) waiting on you: run '{product} question inbox', "
            f"then '{product} question answer <id>'. {run_count} run(s) and {landing_count} landing(s) live."
        )
    if state in (HeartbeatState.STALLED, HeartbeatState.BLOCKED_STALLED):
        lines.append(f"[{timestamp}] STALLED - {stalled_count} run(s): {stalled_detail}")
    elif state == HeartbeatState.WAITING:
        parked = (
            f" and {inbox_decision.parked_here} parked workflow ruling(s)"
            if inbox_decision.parked_here
            else ""
        )
        details = [detail for detail in (waiting_detail, open_request_detail) if detail]
        detail = f": {' | '.join(details)}" if details else ""
        requests = (
            f" and {open_request_count} open request(s)"
            if open_request_count
            else ""
        )
        lines.append(
            f"[{timestamp}] WAITING - {run_count} run(s) and {landing_count} landing(s){parked}{requests}, "
            f"nothing needed from you{detail}"
        )
    return HeartbeatDecision(lines=lines, should_exit=state == HeartbeatState.CLEAR)


def monitor_failure_reason(data: bytes) -> str:
    had_bytes = bool(data)
    printable = "".join(
        chr(value) for value in data[:NOTICE_REASON_MAX_BYTES] if value == 10 or 32 <= value <= 126
    )
    reason = next((line[:NOTICE_REASON_MAX_CHARS] for line in printable.splitlines() if line.split()), "")
    if contains_secret_shaped(reason):
        return "reason withheld (secret-shaped)"
    if reason:
        return reason
    return "stderr not printable" if had_bytes else "stderr empty"


if __name__ == "__main__":
    if sys.argv[1:] == ["tick"]:
        inbox = json.load(sys.stdin)
        decision = heartbeat_decision(
            os.environ["HEARTBEAT_TIMESTAMP"],
            inbox,
            int(os.environ["HEARTBEAT_RUNS"]),
            int(os.environ["HEARTBEAT_LANDINGS"]),
            int(os.environ["HEARTBEAT_STALLED"]),
            os.environ["HEARTBEAT_STALLED_DETAIL"],
            os.environ["HEARTBEAT_WAITING_DETAIL"],
            int(os.environ.get("HEARTBEAT_OPEN_REQUESTS", "0")),
            os.environ.get("HEARTBEAT_OPEN_REQUEST_DETAIL", ""),
        )
        rendered = "\n".join(decision.lines)
        if rendered:
            sys.stdout.write(rendered + "\n")
        raise SystemExit(
            HEARTBEAT_CLEAR_EXIT_STATUS
            if decision.should_exit
            else HEARTBEAT_KEEP_LOOP_EXIT_STATUS
        )
    elif sys.argv[1:] == ["inbox"]:
        decision = decide_inbox_questions(json.load(sys.stdin))
        print(decision.state_key)
    elif sys.argv[1:] and sys.argv[1] == "requests" and len(sys.argv) == 3:
        rows = json.load(sys.stdin)
        roots = [
            root
            for root in rows["roots"]
            if root.get("author_session") == sys.argv[2]
        ]
        requests = open_board_requests(
            roots,
            rows["replies"],
            sys.argv[2],
            datetime.datetime.now(datetime.timezone.utc).timestamp(),
        )
        print(
            "STATE",
            len(requests),
            " | ".join(str(root.get("label")) for root in requests),
            ",".join(str(root.get("id")) for root in requests),
            sep="\t",
        )
    else:
        print(monitor_failure_reason(sys.stdin.buffer.read()))
