"""Pure Stop-hook ruling for a held worktree: in-flight landing is information.

A live ship-task cursor of this session at a step before finish-ship-cleanup, or
an open pull request on the tree's branch, means the tree is in flight. Close-out
still blocks on every held tree.
"""

from __future__ import annotations

from typing import NamedTuple

SHIP_TASK_WORKFLOW = "ship-task"
FINISH_SHIP_CLEANUP_STEP = "finish-ship-cleanup"
AFTER_FINISH_SHIP_CLEANUP = frozenset(
    {FINISH_SHIP_CLEANUP_STEP, "promote-release", "close-task"}
)
HELD_RUN_PREFIX = "held run "


class HeldTreeFacts(NamedTuple):
    path: str
    branch: str | None
    cursor_id: int | None
    cursor_step: str | None
    cursor_workflow: str | None
    cursor_live: bool
    open_pr: str | None


class HeldTreeDecision(NamedTuple):
    block: bool
    in_flight_line: str | None


def cursor_is_in_flight(
    workflow: str | None, step: str | None, live: bool
) -> bool:
    return live and workflow == SHIP_TASK_WORKFLOW and step not in AFTER_FINISH_SHIP_CLEANUP


def format_in_flight_line(tree: HeldTreeFacts) -> str:
    if cursor_is_in_flight(tree.cursor_workflow, tree.cursor_step, tree.cursor_live):
        ref = f"cursor {tree.cursor_id}"
        if tree.cursor_step:
            ref = f"{ref} {tree.cursor_step}"
    else:
        ref = tree.open_pr
    return f"in flight: {tree.path} ({ref})"


def decide_held_tree(tree: HeldTreeFacts, session_close_out: bool) -> HeldTreeDecision:
    in_flight = (not session_close_out) and (
        cursor_is_in_flight(tree.cursor_workflow, tree.cursor_step, tree.cursor_live)
        or bool(tree.open_pr)
    )
    if in_flight:
        return HeldTreeDecision(block=False, in_flight_line=format_in_flight_line(tree))
    return HeldTreeDecision(block=True, in_flight_line=None)


def parse_held_run_report(report: str) -> tuple[str, str] | None:
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
    return run_id, path
