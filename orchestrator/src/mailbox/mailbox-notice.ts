// concern: run-inbox
/** Pure operator wording for transports that cannot add context to a live turn. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
export function deferredWorkerMessageNotice(runId: number, canInjectMidTurn: boolean): string {
  if (canInjectMidTurn) return ''
  return (
    'It will NOT reach the running turn unless the worker polls check_orchestrator_messages. ' +
    `It is queued for the next turn's prompt. Once this turn ends, run "${PLATFORM_SLUG} run continue ${runId}". ` +
    'The continuation will deliver it after restoring the recorded checkout, or refuse before creating a turn and tell you to dispatch a new run.'
  )
}
