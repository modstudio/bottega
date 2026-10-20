#!/usr/bin/env python3
"""Pure heartbeat presentation decisions used by the shell adapter."""

import re
import os
import sys
import base64
import binascii
import json

NOTICE_REASON_MAX_BYTES = 4096
NOTICE_REASON_MAX_CHARS = 240

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


def heartbeat_lines(
    timestamp: str,
    asking: int,
    run_count: int,
    landing_count: int,
    stalled_count: int,
    stalled_detail: str,
    waiting_detail: str,
) -> list[str]:
    product = "bottega"
    lines = []
    if asking > 0:
        lines.append(
            f"[{timestamp}] BLOCKED - {asking} question(s) waiting on you: run '{product} question inbox', "
            f"then '{product} question answer <id>'. {run_count} run(s) and {landing_count} landing(s) live."
        )
    if stalled_count > 0:
        lines.append(f"[{timestamp}] STALLED - {stalled_count} run(s): {stalled_detail}")
    elif asking == 0 and (run_count > 0 or landing_count > 0):
        lines.append(
            f"[{timestamp}] WAITING - {run_count} run(s) and {landing_count} landing(s), "
            f"nothing needed from you: {waiting_detail}"
        )
    return lines


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
        rendered = "\n".join(
            heartbeat_lines(
                os.environ["HEARTBEAT_TIMESTAMP"],
                int(os.environ["HEARTBEAT_ASKING"]),
                int(os.environ["HEARTBEAT_RUNS"]),
                int(os.environ["HEARTBEAT_LANDINGS"]),
                int(os.environ["HEARTBEAT_STALLED"]),
                os.environ["HEARTBEAT_STALLED_DETAIL"],
                os.environ["HEARTBEAT_WAITING_DETAIL"],
            )
        )
        if rendered:
            sys.stdout.write(rendered + "\n")
    else:
        print(monitor_failure_reason(sys.stdin.buffer.read()))
