"""Read the canonical inbox group carried by each question row."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class InboxQuestionDecision:
    worker: int
    user: int
    state_key: str


def decide_inbox_questions(items):
    if not isinstance(items, list):
        raise ValueError("invalid inbox JSON")
    grouped = {"worker": set(), "user": set()}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("invalid inbox JSON")
        kind = "workflow" if item.get("kind") == "workflow" else "worker"
        question_id = item.get("question_id")
        group = item.get("group")
        if not isinstance(question_id, int) or group not in (
            "worker",
            "user",
            "foreign",
            "unowned",
        ):
            raise ValueError("invalid inbox JSON")
        if group in grouped:
            grouped[group].add((kind, question_id))
    state_key = ",".join(
        f"{kind}:{question_id}:{group}"
        for group in ("worker", "user")
        for kind, question_id in sorted(grouped[group])
    )
    return InboxQuestionDecision(
        worker=len(grouped["worker"]), user=len(grouped["user"]), state_key=state_key
    )
