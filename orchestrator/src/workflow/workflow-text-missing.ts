// concern: workflow text missing-message decision
/** Describes a missing workflow-text attachment according to the store that was checked. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type WorkflowTextStoreMode = 'hosted' | 'local-authoritative'

export function missingWorkflowTextMessage(
  token: string,
  mode: WorkflowTextStoreMode,
): { condition: string; remedy: string } {
  if (mode === 'hosted') {
    return {
      condition:
        `${token} has no live workflow text or copy link in the record for your spaces; ` +
        'it was never written there, or it was deleted without a copy. An id attached by a process ' +
        'using a different local store (an unbound store, or a BOTTEGA_ORCHESTRATOR_DB override) ' +
        'exists only in that store.',
      remedy: `re-attach the text with ${PLATFORM_SLUG} workflow attach, or paste the body into the spec`,
    }
  }
  return {
    condition:
      `${token} has no live workflow text or copy link in this machine's store; ` +
      'an id attached on another machine is readable only through its task document.',
    remedy:
      `re-attach the text with ${PLATFORM_SLUG} workflow attach, read another machine's attachment ` +
      'through its task document, or paste the body into the spec',
  }
}

export class WorkflowTextNotHeldError extends Error {
  readonly condition: string
  readonly remedy: string

  constructor(condition: string, remedy: string) {
    super(`${condition}\nremedy: ${remedy}`)
    this.name = 'WorkflowTextNotHeldError'
    this.condition = condition
    this.remedy = remedy
  }
}
