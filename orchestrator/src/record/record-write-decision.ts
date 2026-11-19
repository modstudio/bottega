// concern: record-write-decision
/** Decides shared-state write authority from plain install facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { isDiscardStorePath, ORCHESTRATOR_DATABASE_ENV } from '../../../shared/state-directory.ts'

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
  machineJoined: boolean | 'unreadable'
  localByDesign: boolean
  storePath: string
  storeOverride: boolean
}): RecordWriteDecision {
  const unboundStoreRemedies = () => [
    ...(input.storeOverride
      ? ([{ kind: 'edit', text: `unset ${ORCHESTRATOR_DATABASE_ENV}` }] as const)
      : []),
    { kind: 'command' as const, argv: [PLATFORM_SLUG, 'record', 'use', '<address>'] },
  ]
  // An explicitly configured address overrides the pin: record use is how an install switches records.
  if (input.recordApiConfigured) return { verdict: 'hosted' }
  if (!input.installBound) {
    if (input.localByDesign || isDiscardStorePath(input.storePath)) {
      return { verdict: 'local-authoritative' }
    }
    if (input.machineJoined === 'unreadable') {
      return {
        verdict: 'refused',
        boundOrigin: null,
        resolvedOrigin: input.resolvedOrigin,
        refusal: renderRefusal(
          refusal(
            'whether this machine has joined a hosted record could not be established because the record session stamp is unreadable',
            unboundStoreRemedies(),
          ),
        ),
      }
    }
    if (!input.machineJoined) {
      return { verdict: 'local-authoritative' }
    }
    return {
      verdict: 'refused',
      boundOrigin: null,
      resolvedOrigin: input.resolvedOrigin,
      refusal: renderRefusal(
        refusal(
          'this machine has signed in to a hosted record, but this store is not bound to it and no record address is set',
          unboundStoreRemedies(),
        ),
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
