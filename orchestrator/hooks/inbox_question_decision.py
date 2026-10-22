"""Pure classification of question-inbox rows for session notifications."""

from typing import NamedTuple


class InboxQuestionDecision(NamedTuple):
    answerable_now: int
    parked_here: int
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
    """Whether this session must act on this inbox question now."""
    if item.kind != "workflow":
        return item.can_answer
    # A workflow owned by this session reached the inbox because this session
    # deliberately parked it with `workflow await`. It is not a worker waiting
    # for an answer from the session that dispatched it.
    return item.can_answer and item.workflow_session_id is None


def decide_inbox_questions(items):
    return decide_parsed_inbox_questions(parse_inbox_questions(items))


def decide_parsed_inbox_questions(items):
    answerable = set()
    parked = set()
    for item in items:
        identity = (item.kind, item.question_id)
        if question_is_answerable_now(item):
            answerable.add(identity)
        elif (
            item.kind == "workflow"
            and item.can_answer
            and item.workflow_session_id is not None
        ):
            parked.add(identity)
    state_key = ",".join(
        f"{kind}:{question_id}:{state}"
        for state, identities in (("answerable", answerable), ("parked", parked))
        for kind, question_id in sorted(identities)
    )
    return InboxQuestionDecision(len(answerable), len(parked), state_key)
