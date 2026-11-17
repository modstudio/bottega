// concern: record-identity
/** Resolves local run references without loading the full identity resolver graph. */

import type { Database } from 'bun:sqlite'

export type LocalRunIdentity = { record_id: string; project_record_id: string | null }
export type LocalRunReference =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export class ResolutionMissError extends Error {}

export function visibilityRefusal(scope: string): never {
  throw new ResolutionMissError(
    `reference is not visible in ${scope}; pass the UUID or a qualified label`,
  )
}

export function uuidVisibilityRefusal(): never {
  throw new ResolutionMissError('reference is not visible in any space you belong to')
}

export function resolveLocalRun(
  database: Database,
  reference: LocalRunReference,
): LocalRunIdentity {
  const row = database
    .query<LocalRunIdentity, [number | string]>(
      reference.kind === 'number'
        ? 'SELECT record_id,project_record_id FROM run WHERE number=?'
        : 'SELECT record_id,project_record_id FROM run WHERE record_id=?',
    )
    .get(reference.kind === 'number' ? reference.number : reference.recordId)
  if (!row) {
    if (reference.kind === 'record-id') uuidVisibilityRefusal()
    visibilityRefusal('this machine')
  }
  return row
}
