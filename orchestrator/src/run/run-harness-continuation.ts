// concern: harness continuation
/** Keeps every continuation on its processless harness executor. */

import { HARNESS_AGENT, HARNESS_EXECUTOR } from './run-executor.ts'

export function harnessContinuationWorker(executor: 'external' | 'harness' | undefined) {
  return executor === HARNESS_EXECUTOR ? { agent: HARNESS_AGENT, session: undefined } : null
}
