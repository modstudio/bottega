// concern: question inbox group decision
/** Classifies one open question relative to the session viewing the inbox. */

export type QuestionInboxGroup = 'worker' | 'user' | 'foreign' | 'unowned'

export function questionInboxGroup(input: {
  kind: 'worker' | 'workflow'
  ownerSessionId: string | null
  awaitingOperator: boolean
  callerSessionId: string | null
}): QuestionInboxGroup {
  if (input.ownerSessionId === null) return 'unowned'
  if (input.ownerSessionId !== input.callerSessionId) return 'foreign'
  if (input.kind === 'workflow' || input.awaitingOperator) return 'user'
  return 'worker'
}
