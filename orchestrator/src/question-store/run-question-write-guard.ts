// concern: run-question-write-guard
/** Defines the refusal shared by question stores when a run no longer owns its ask channel. */

export const RUN_QUESTION_OWNER_NOT_LIVE = 'turn was superseded or finished'

export function runQuestionOwnerNotLiveMessage(runId: string): string {
  return `run ${runId}'s ${RUN_QUESTION_OWNER_NOT_LIVE}; the worker must stop because this turn no longer owns its escalation channel`
}

export function isRunQuestionOwnerNotLive(error: unknown): boolean {
  return String(error).includes(RUN_QUESTION_OWNER_NOT_LIVE)
}
