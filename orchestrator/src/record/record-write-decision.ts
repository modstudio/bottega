// concern: record-write-decision
/** Decides shared-state write authority from plain install facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

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
  machineJoined: boolean
  localByDesign: boolean
}): RecordWriteDecision {
  // An explicitly configured address overrides the pin: record use is how an install switches records.
  if (input.recordApiConfigured) return { verdict: 'hosted' }
  if (!input.installBound) {
    if (!input.machineJoined || input.localByDesign) return { verdict: 'local-authoritative' }
    return {
      verdict: 'refused',
      boundOrigin: null,
      resolvedOrigin: input.resolvedOrigin,
      refusal:
        renderRefusal(
          refusal(
            'this machine has signed in to a hosted record, but this store is not bound to it and no record address is set',
            { kind: 'edit', text: 'unset BOTTEGA_ORCHESTRATOR_DB' },
          ),
        ) +
        renderRefusal(
          refusal('', {
            kind: 'command',
            argv: [PLATFORM_SLUG, 'record', 'use', '<address>'],
          }),
        ),
    }
  }
  if (input.boundOrigin === null) {
    return {
      verdict: 'refused',
      boundOrigin: null,
      resolvedOrigin: input.resolvedOrigin,
      refusal: renderRefusal(
        refusal('this install is bound to a hosted record with no recorded address', {
          kind: 'command',
          argv: [PLATFORM_SLUG, 'record', 'use', '<address>'],
        }),
      ),
    }
  }
  if (input.boundOrigin === input.resolvedOrigin) return { verdict: 'hosted' }
  return {
    verdict: 'refused',
    boundOrigin: input.boundOrigin,
    resolvedOrigin: input.resolvedOrigin,
    refusal: renderRefusal(
      refusal(
        `this install is bound to ${input.boundOrigin}, but the resolved record origin is ${input.resolvedOrigin}`,
        {
          kind: 'command',
          argv: [PLATFORM_SLUG, 'record', 'use', input.boundOrigin],
        },
      ),
    ),
  }
}
