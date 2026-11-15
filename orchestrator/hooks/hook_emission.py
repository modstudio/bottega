"""Fail-silent recording of product-hook output measurements."""

import hashlib
import os
import re
import subprocess
import sys

from hook_paths import bottega_bin

NORMALIZATIONS = [
    (re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b"), "<time>"),
    (re.compile(r"\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AP]M)?\b", re.I), "<time>"),
    (re.compile(r"\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b", re.I), "<duration>"),
    (re.compile(r"\b(?:run|cursor)(?:\s+|[-_#:]*)\d+\b", re.I), lambda m: re.sub(r"\d+", "<n>", m.group(0))),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.I), "<id>"),
    (re.compile(r"\b[0-9A-HJKMNP-TV-Z]{26}\b"), "<id>"),
    (re.compile(r"\b[0-9a-f]{16,64}\b", re.I), "<id>"),
    (re.compile(r"\b\d+(?:\.\d+)?\s*(?:bytes?|KiB|MiB|GiB|KB|MB|GB)\b", re.I), "<bytes>"),
]


def normalized_text(text):
    normalized = text
    for pattern, replacement in NORMALIZATIONS:
        normalized = pattern.sub(replacement, normalized)
    return normalized


def text_hash(text):
    return hashlib.sha256(normalized_text(text).encode("utf-8")).hexdigest()


def launch_detached(bottega, args, env, cwd, *, launch=subprocess.Popen):
    return launch(
        [bottega, *args], env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, cwd=cwd,
    )


def record_emission(payload, hook, kind, text, *, launch=subprocess.Popen):
    """Launch detached recording; never raise into the hook output path."""
    try:
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        event = payload.get("hook_event_name")
        if not isinstance(session, str) or not session or not isinstance(event, str) or not event:
            raise ValueError("session id and hook event name are required")
        launch_detached(
            bottega_bin(), ["agent", "context", "record-emission",
             "--session", session, "--event", event, "--hook", hook, "--kind", kind,
             "--chars", str(len(text)), "--lines", str(0 if not text else text.count("\n") + 1),
             "--hash", text_hash(text)], os.environ.copy(), payload.get("cwd") or None, launch=launch,
        )
    except Exception as error:
        print(f"{hook}: emission recording failed: {error}", file=sys.stderr)
