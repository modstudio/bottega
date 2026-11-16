"""Fail-silent recording of product-hook output measurements."""

import hashlib
import os
import re
import subprocess
import sys

from hook_paths import bottega_bin, state_root

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

HOOK_EMISSION_KINDS = (
    "additionalContext",
    "systemMessage",
    "blockReason",
    "denyReason",
    "allowReason",
    "askReason",
)


def normalized_text(text):
    normalized = text
    for pattern, replacement in NORMALIZATIONS:
        normalized = pattern.sub(replacement, normalized)
    return normalized


def text_hash(text):
    return hashlib.sha256(normalized_text(text).encode("utf-8")).hexdigest()


def text_stats(text):
    return len(text.encode("utf-8")), 0 if not text else text.count("\n") + 1, len(text)


def launch_detached(executable, args, env, cwd, *, launch=None, stderr=subprocess.DEVNULL):
    launcher = launch or subprocess.Popen
    return launcher(
        [executable, *args], env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=stderr,
        start_new_session=True, cwd=cwd,
    )


def record_emission(payload, kind, text, *, launch=None, hook=None):
    """Launch detached recording; never raise into the hook output path."""
    hook = hook or os.path.splitext(os.path.basename(sys.argv[0]))[0]
    if kind not in HOOK_EMISSION_KINDS:
        print(f"{hook}: invalid hook emission kind: {kind}", file=sys.stderr)
        return
    try:
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        event = payload.get("hook_event_name")
        if not isinstance(session, str) or not session or not isinstance(event, str) or not event:
            return
        _bytes, lines, chars = text_stats(text)
        environment = os.environ.copy()
        log_path = os.path.join(state_root(environment), "orchestrator", "hook-emission.log")
        os.makedirs(os.path.dirname(log_path), mode=0o700, exist_ok=True)
        descriptor = os.open(
            log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(descriptor, "a", encoding="utf-8") as log:
            launch_detached(
                bottega_bin(), ["agent", "context", "record-emission",
                 "--session", session, "--event", event, "--hook", hook, "--kind", kind,
                 "--chars", str(chars), "--lines", str(lines),
                 "--hash", text_hash(text)], environment, payload.get("cwd") or None,
                launch=launch, stderr=log,
            )
    except Exception as error:
        print(f"{hook}: emission recording failed: {error}", file=sys.stderr)
