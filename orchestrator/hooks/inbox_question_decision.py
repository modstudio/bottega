"""Pure classification of question-inbox rows for session notifications."""

from typing import NamedTuple


class InboxQuestionDecision(NamedTuple):
    answerable_now: int
    parked_here: int
    state_key: str


def _question_identity(item):
    kind = "workflow" if item.get("kind") == "workflow" else "worker"
    question_id = item.get("question_id")
    if not isinstance(question_id, int):
        raise ValueError("invalid inbox JSON")
    return kind, question_id


def question_is_answerable_now(item):
    """Whether this session must act on this inbox question now."""
    if not isinstance(item, dict) or not isinstance(item.get("can_answer"), bool):
        raise ValueError("invalid inbox JSON")
    if item.get("kind") != "workflow":
        return item["can_answer"]
    owner = item.get("session_id")
    if owner is not None and not isinstance(owner, str):
        raise ValueError("invalid inbox JSON")
    # A workflow owned by this session reached the inbox because this session
    # deliberately parked it with `workflow await`. It is not a worker waiting
    # for an answer from the session that dispatched it.
    return item["can_answer"] and owner is None


def decide_inbox_questions(items):
    if not isinstance(items, list):
        raise ValueError("invalid inbox JSON")
    answerable = set()
    parked = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("invalid inbox JSON")
        identity = _question_identity(item)
        if question_is_answerable_now(item):
            answerable.add(identity)
        elif (
            item.get("kind") == "workflow"
            and item["can_answer"]
            and isinstance(item.get("session_id"), str)
        ):
            parked.add(identity)
    state_key = ",".join(
        f"{kind}:{question_id}:{state}"
        for state, identities in (("answerable", answerable), ("parked", parked))
        for kind, question_id in sorted(identities)
    )
    return InboxQuestionDecision(len(answerable), len(parked), state_key)
