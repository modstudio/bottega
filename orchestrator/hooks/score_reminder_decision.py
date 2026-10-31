"""Pure Stop-hook decisions for held trees, blocking, and once-per-note information.

Unscored runs, pairs, and holds block; notes never do.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple


REFUSAL_QUOTE_CHARS = 200
WRITING_JOBS = {"fix", "implement", "issue-worker"}
REQUIRED_REPLY_KEYS = {
    "status", "summary", "files_changed", "change_guide", "questions",
    "deviations", "blockers", "tests",
}
REPLY_STATUSES = {"done", "asking", "refused"}
# Literal mirror of failure.ts isNotEvidenceFailure. route-unscored.test.ts
# holds the copies equal because this Python hook cannot import TypeScript.
NOT_EVIDENCE = {
    "capacity",
    "daily_quota",
    "quota",
    "billing",
    "provider_error",
    "auth",
    "entitlement",
    "unreachable",
    "context",
    "cost",
    "content_refusal",
    "interrupted",
    "idle",
    "truncated",
    "escaped",
    "confinement_unverified",
    "sandbox_denied",
    "mcp_unverified",
    "harness",
    "abandoned",
    "unevidenced",
}


class HeldTreeDecision(NamedTuple):
    block: bool
    in_flight_line: str | None


class StopDecision(NamedTuple):
    block: bool
    note_lines: list[str]
    seen: list[str]


def decide_stop(
    unscored_runs: int,
    pairs: int,
    blocking_holds: int,
    notes: list[tuple[str, str, str]],
    seen: set[str] | None,
) -> StopDecision:
    unseen = notes if seen is None else [note for note in notes if note[0] not in seen]
    note_lines = []
    if unseen:
        count = len(unseen)
        note_lines.append(
            f"{count} note{'s' if count != 1 else ''} filed in this session; "
            "hand each to its project's architects:"
        )
        note_lines.extend(
            f"  {label}  {text[:80]}  "
            f"(hand it to architects:{project} with a board request)"
            for label, text, project in unseen
        )
    updated_seen = set() if seen is None else set(seen)
    updated_seen.update(label for label, _text, _project in unseen)
    return StopDecision(
        block=bool(unscored_runs or pairs or blocking_holds),
        note_lines=note_lines,
        seen=sorted(updated_seen),
    )


def unscored_remedy(status: str, failure_kind: str | None, agent: str) -> str:
    if status == "ok":
        return "axes"
    if failure_kind in NOT_EVIDENCE or (
        failure_kind == "stopped" and agent == "(pending)"
    ):
        return "void"
    return "none"


def decide_held_tree(tree: dict) -> HeldTreeDecision:
    ref = tree.get("inFlightRef")
    if tree.get("suppressBlock") and ref:
        return HeldTreeDecision(
            block=False,
            in_flight_line=f"in flight: {tree['worktree']} ({ref})",
        )
    return HeldTreeDecision(block=True, in_flight_line=None)


def _worker_replies(text: str):
    decoder = json.JSONDecoder()
    for offset, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text, offset)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and REQUIRED_REPLY_KEYS.issubset(value)
            and value.get("status") in REPLY_STATUSES
            and isinstance(value.get("summary"), str)
        ):
            yield value


def refusal_score_guidance(output_path: str | None, job_name: str) -> str | None:
    if not output_path:
        return None
    try:
        text = Path(output_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if "\ufffd" in text:
        return None
    replies = list(_worker_replies(text))
    if not replies or replies[-1].get("status") != "refused":
        return None
    summary = replies[-1]["summary"].splitlines()[0] if replies[-1]["summary"] else ""
    if len(summary) > REFUSAL_QUOTE_CHARS:
        cut = next(
            (
                index
                for index in range(REFUSAL_QUOTE_CHARS, -1, -1)
                if summary[index].isspace()
            ),
            REFUSAL_QUOTE_CHARS,
        )
        summary = summary[:cut] + "…"
    faithful = " faithful" if job_name in WRITING_JOBS else ""
    return (
        f"refused: {json.dumps(summary, ensure_ascii=False)}; judge the refusal on its merits "
        f"(correct with evidence: full right{faithful}; should have asked: full mixed{faithful}; "
        "false evidence: full wrong; no evidence: none), or rule and continue the chain and "
        "score it after."
    )
