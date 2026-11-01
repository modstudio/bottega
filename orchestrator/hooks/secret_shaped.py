"""Detection and span redaction for text that resembles credentials."""

import base64
import binascii
import json
import re
from pathlib import Path


_TABLE_PATH = Path(__file__).resolve().parents[2] / "shared" / "secret-shaped-rules.json"
_TABLE = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))
_RULES = [
    {
        **definition,
        "regex": re.compile(
            definition["pattern"], re.IGNORECASE if definition["ignoreCase"] else 0
        ),
    }
    for definition in _TABLE["rules"]
]
_EXEMPT_EVIDENCE_TOKEN = re.compile(
    _TABLE["exemptEvidenceToken"]["pattern"],
    re.IGNORECASE if _TABLE["exemptEvidenceToken"]["ignoreCase"] else 0,
)


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
    has_marker = any(character in "+=" for character in run)
    has_lower = any("a" <= character <= "z" for character in run)
    has_upper = any("A" <= character <= "Z" for character in run)
    has_digit = any("0" <= character <= "9" for character in run)
    return len(decoded) >= _TABLE["base64MinBytes"] and (
        has_marker or (has_lower and has_upper and has_digit)
    )


def _rule_spans(rule: dict, text: str) -> list[tuple[int, int]]:
    matches = rule["regex"].finditer(text)
    if rule["kind"] == "pem":
        spans = []
        for match in matches:
            end_marker = f"-----END {match.group(1)}-----"
            end_start = text.find(end_marker, match.end())
            end = len(text) if end_start < 0 else end_start + len(end_marker)
            spans.append((match.start(), end))
        return spans
    if rule["kind"] == "jwt":
        return [match.span() for match in matches if _jwt_header_is_object(match.group(0))]
    if rule["kind"] == "base64":
        return [match.span() for match in matches if _base64_run_is_secret(match.group(0))]
    return [match.span() for match in matches]


def redact_secret_shaped(
    text: str, exempt_evidence_tokens: bool = False
) -> tuple[str, list[str]]:
    """Mask matching spans and return the table-ordered rules that matched."""
    exemptions = (
        [match.span() for match in _EXEMPT_EVIDENCE_TOKEN.finditer(text)]
        if exempt_evidence_tokens
        else []
    )
    rule_spans = [
        (rule, [span for span in _rule_spans(rule, text) if span not in exemptions])
        for rule in _RULES
    ]
    rules = [rule["name"] for rule, spans in rule_spans if spans]
    spans = sorted(
        (
            (start, end, rule["name"], rule_index)
            for rule_index, (rule, matches) in enumerate(rule_spans)
            for start, end in matches
        ),
        key=lambda span: (span[0], span[3]),
    )
    merged: list[list] = []
    for start, end, rule, rule_index in spans:
        if merged and start < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end, rule, rule_index])
    cursor = 0
    parts = []
    for start, end, rule, _rule_index in merged:
        parts.extend((text[cursor:start], f"[withheld: {rule}]"))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts), rules


def contains_secret_shaped(text: str) -> bool:
    """Return whether any rule recognizes a secret-shaped span."""
    return any(_rule_spans(rule, text) for rule in _RULES)
