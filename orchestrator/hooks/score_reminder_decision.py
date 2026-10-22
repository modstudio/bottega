"""Pure Stop-hook ruling for a held worktree: in-flight landing is information.

Close-out JSON carries hold kind, in-flight ref, and suppressBlock. The hook
reads those fields and does not re-derive them or parse the human report.
"""

from __future__ import annotations

from typing import NamedTuple


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
