"""Pure classification of question-inbox rows for session notifications."""

from __future__ import annotations

from typing import NamedTuple


class InboxQuestionDecision(NamedTuple):
    answerable_now: int
    state_key: str


class InboxQuestion(NamedTuple):
    kind: str
    question_id: int
    can_answer: bool
    workflow_session_id: str | None


def parse_inbox_questions(items):
    """Parse the inbox fields shared by heartbeat and session-brief decisions."""
    if not isinstance(items, list):
        raise ValueError("invalid inbox JSON")
    parsed = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("invalid inbox JSON")
        kind = "workflow" if item.get("kind") == "workflow" else "worker"
        question_id = item.get("question_id")
        can_answer = item.get("can_answer")
        workflow_session_id = item.get("session_id") if kind == "workflow" else None
        if (
            not isinstance(question_id, int)
            or not isinstance(can_answer, bool)
            or (
                kind == "workflow"
                and workflow_session_id is not None
                and not isinstance(workflow_session_id, str)
            )
        ):
            raise ValueError("invalid inbox JSON")
        parsed.append(
            InboxQuestion(kind, question_id, can_answer, workflow_session_id)
        )
    return parsed


def question_is_answerable_now(item):
    """Whether this session must act on this inbox question now.

    Run questions and workflow-ruling questions share the inbox `can_answer`
    field.
    """
    return item.can_answer


def decide_inbox_questions(items):
    return decide_parsed_inbox_questions(parse_inbox_questions(items))


def decide_parsed_inbox_questions(items):
    answerable = set()
    for item in items:
        if question_is_answerable_now(item):
            answerable.add((item.kind, item.question_id))
    state_key = ",".join(
        f"{kind}:{question_id}:answerable" for kind, question_id in sorted(answerable)
    )
    return InboxQuestionDecision(len(answerable), state_key)
