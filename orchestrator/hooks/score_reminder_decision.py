"""Pure Stop-hook ruling for a held worktree: in-flight landing is information.

Close-out's hold report carries whether the tree's landing is in flight, with the
cursor or PR it rests on. The hook reads that fact and does not re-derive it.
Unique-work holds still block.
"""

from __future__ import annotations

from typing import NamedTuple

HELD_RUN_PREFIX = "held run "
IN_FLIGHT_HOLD_PREFIX = "in flight ("


class HeldTreeFacts(NamedTuple):
    path: str
    in_flight_ref: str | None


class HeldTreeDecision(NamedTuple):
    block: bool
    in_flight_line: str | None


def decide_held_tree(tree: HeldTreeFacts) -> HeldTreeDecision:
    if tree.in_flight_ref:
        return HeldTreeDecision(
            block=False,
            in_flight_line=f"in flight: {tree.path} ({tree.in_flight_ref})",
        )
    return HeldTreeDecision(block=True, in_flight_line=None)


def parse_held_run_report(report: str) -> HeldTreeFacts | None:
    if not report.startswith(HELD_RUN_PREFIX):
        return None
    rest = report[len(HELD_RUN_PREFIX) :]
    id_end = rest.find(" ")
    if id_end < 0:
        return None
    run_id = rest[:id_end]
    remainder = rest[id_end + 1 :]
    sep = remainder.find(": ")
    if sep < 0 or not run_id:
        return None
    path = remainder[:sep]
    if not path:
        return None
    detail = remainder[sep + 2 :]
    in_flight_ref = None
    if detail.startswith(IN_FLIGHT_HOLD_PREFIX):
        end = detail.find("); ", len(IN_FLIGHT_HOLD_PREFIX))
        if end > 0:
            in_flight_ref = detail[len(IN_FLIGHT_HOLD_PREFIX) : end]
    return HeldTreeFacts(path=path, in_flight_ref=in_flight_ref)
