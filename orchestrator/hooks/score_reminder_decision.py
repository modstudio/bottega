"""Pure Stop-hook ruling for a held worktree: in-flight landing is information.

Close-out JSON carries hold kind, in-flight ref, and suppressBlock. The hook
reads those fields and does not re-derive them or parse the human report.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple


REFUSAL_QUOTE_CHARS = 200


class HeldTreeDecision(NamedTuple):
    block: bool
    in_flight_line: str | None


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
    required = {
        "status", "summary", "files_changed", "change_guide", "questions",
        "deviations", "blockers", "tests",
    }
    for offset, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text, offset)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and required.issubset(value)
            and value.get("status") in {"done", "asking", "refused"}
            and isinstance(value.get("summary"), str)
        ):
            yield value


def refusal_score_guidance(output_path: str | None, writing_job: bool) -> str | None:
    if not output_path:
        return None
    try:
        replies = list(_worker_replies(Path(output_path).read_text()))
    except FileNotFoundError:
        return None
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
    faithful = " faithful" if writing_job else ""
    return (
        f"refused: {json.dumps(summary, ensure_ascii=False)}; judge the refusal on its merits "
        f"(correct with evidence: full right{faithful}; should have asked: full mixed{faithful}; "
        "false evidence: full wrong; no evidence: none), or rule and continue the chain and "
        "score it after."
    )
