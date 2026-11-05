// concern: record-write-decision
/** Decides shared-state write authority from plain install facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type RecordWriteDecision =
  | { verdict: 'hosted' | 'local-authoritative' }
  | {
      verdict: 'refused'
      refusal: string
      boundOrigin: string | null
      resolvedOrigin: string
    }

export function decideRecordWrite(input: {
  recordApiConfigured: boolean
  installBound: boolean
  boundOrigin: string | null
  resolvedOrigin: string
}): RecordWriteDecision {
  // An explicitly configured address overrides the pin: record use is how an install switches records.
  if (input.recordApiConfigured) return { verdict: 'hosted' }
  if (!input.installBound) return { verdict: 'local-authoritative' }
  if (input.boundOrigin === null) {
    return {
      verdict: 'refused',
      boundOrigin: null,
      resolvedOrigin: input.resolvedOrigin,
      refusal:
        'this install is bound to a hosted record with no recorded address\n' +
        `cleared by: ${PLATFORM_SLUG} record use <address>`,
    }
  }
  if (input.boundOrigin === input.resolvedOrigin) return { verdict: 'hosted' }
  return {
    verdict: 'refused',
    boundOrigin: input.boundOrigin,
    resolvedOrigin: input.resolvedOrigin,
    refusal:
      `this install is bound to ${input.boundOrigin}, but the resolved record origin is ${input.resolvedOrigin}\n` +
      `cleared by: ${PLATFORM_SLUG} record use ${input.boundOrigin}`,
  }
}
