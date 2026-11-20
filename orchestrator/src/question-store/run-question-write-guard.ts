// concern: run-question-write-guard
/** Defines the refusal shared by question stores when a run no longer owns its ask channel. */

const RUN_QUESTION_OWNER_NOT_LIVE = 'turn was superseded or finished'
export const RUN_QUESTION_OWNER_NOT_LIVE_CODE = 'run-question-owner-not-live'

export function runQuestionOwnerLive(status: string | null | undefined): boolean {
  return status === 'running' || status === 'asking'
}

export function runQuestionOwnerNotLiveMessage(runId: string): string {
  return `run ${runId}'s ${RUN_QUESTION_OWNER_NOT_LIVE}; the worker must stop because this turn no longer owns its escalation channel`
}

export function runQuestionOwnerAbsentMessage(runId: string, platformSlug: string): string {
  return `this question store could not see run ${runId} in this space; run ${platformSlug} record sync and check the project's declared space, then retry`
}

export class RunQuestionOwnerNotLiveError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(runQuestionOwnerNotLiveMessage(runId))
    this.name = 'RunQuestionOwnerNotLiveError'
    this.runId = runId
  }
}

type RunQuestionOwnerNotLiveFailure =
  | RunQuestionOwnerNotLiveError
  | (Error & { cause: RunQuestionOwnerNotLiveError })

export function isRunQuestionOwnerNotLive(error: unknown): error is RunQuestionOwnerNotLiveFailure {
  return (
    error instanceof RunQuestionOwnerNotLiveError ||
    (error instanceof Error && error.cause instanceof RunQuestionOwnerNotLiveError)
  )
}
