"""Pure classification of question-inbox rows for session notifications."""

from __future__ import annotations

from typing import NamedTuple


class InboxQuestionDecision(NamedTuple):
    answerable_now: int
    parked_here: int
    unowned: int
    foreign_workflow: int
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


def decide_inbox_questions(items):
    return decide_parsed_inbox_questions(parse_inbox_questions(items))


def decide_parsed_inbox_questions(items):
    """Partition inbox questions by what this session must do about them.

    A worker question this session can answer is answerable now. A workflow
    question owned by this session was parked here with `workflow await`. A
    workflow question with no owning session waits on no particular session,
    so it is only counted. A workflow question owned elsewhere is counted as
    foreign for the brief and never wakes the heartbeat.
    Only the answerable and parked sets enter the state key, because nothing
    the heartbeat prints depends on the unowned count.
    """
    answerable = set()
    parked = set()
    unowned = set()
    foreign = set()
    for item in items:
        identity = (item.kind, item.question_id)
        if item.kind != "workflow":
            if item.can_answer:
                answerable.add(identity)
        elif item.workflow_session_id is None:
            unowned.add(identity)
        elif item.can_answer:
            parked.add(identity)
        else:
            foreign.add(identity)
    state_key = ",".join(
        f"{kind}:{question_id}:{state}"
        for state, identities in (("answerable", answerable), ("parked", parked))
        for kind, question_id in sorted(identities)
    )
    return InboxQuestionDecision(
        len(answerable), len(parked), len(unowned), len(foreign), state_key
    )
