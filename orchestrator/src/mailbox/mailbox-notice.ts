// concern: run-inbox
/** Pure operator wording for transports that cannot add context to a live turn. */
export function deferredWorkerMessageNotice(runId: number, canInjectMidTurn: boolean): string {
  if (canInjectMidTurn) return ''
  return (
    'It will NOT reach the running turn unless the worker polls check_orchestrator_messages. ' +
    `It WILL be included in the next turn's prompt; once this turn ends, run "orch continue ${runId}" to deliver it.`
  )
}
