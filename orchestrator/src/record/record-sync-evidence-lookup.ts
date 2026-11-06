// concern: record-sync-evidence-lookup
/** Builds the lookup for an evidence row one machine owns. Must not run SQL. */
import type {
  MachineEvidenceTable,
  SpacePrincipalEvidenceTable,
} from './record-evidence-references.ts'

export type OwnedEvidenceLookup = { text: string; values: string[] }
export type ExistingEvidenceOwnership = 'absent' | 'owned' | 'collision'

type OwnedEvidenceLookupBase = {
  id: string
  spaceId: string
  machineId: string
  userId: string
  suffix: string
}

type OwnedEvidenceLookupInput = OwnedEvidenceLookupBase &
  (
    | { scope: 'machine'; table: MachineEvidenceTable }
    | { scope: 'space-principal'; table: SpacePrincipalEvidenceTable }
  )

type ExistingEvidenceOwnershipLookupInput = Omit<OwnedEvidenceLookupBase, 'suffix'> &
  (
    | { scope: 'machine'; table: MachineEvidenceTable }
    | { scope: 'space-principal'; table: SpacePrincipalEvidenceTable }
  )

const ownerColumns: Record<SpacePrincipalEvidenceTable, string> = {
  task_flow: 'opening_machine_id',
  task_flow_stage: 'opened_machine_id',
}

function evidenceOwnershipPredicate(
  input: Omit<OwnedEvidenceLookupBase, 'id' | 'suffix'> &
    (
      | { scope: 'machine'; table: MachineEvidenceTable }
      | { scope: 'space-principal'; table: SpacePrincipalEvidenceTable }
    ),
): { text: string; values: string[] } {
  if (input.scope === 'space-principal') {
    return {
      text: `evidence.space_id=$2::uuid AND owner_machine.user_id=$3::uuid`,
      values: [input.spaceId, input.userId],
    }
  }
  const text = `space_id=$2::uuid AND machine_id=$3::uuid`
  const values = [input.spaceId, input.machineId]
  // Only a run carries its starting user, and Postgres refuses a parameter the statement never uses.
  return input.table === 'run'
    ? { text: `${text} AND started_by_user_id=$4::uuid`, values: [...values, input.userId] }
    : { text, values }
}

export function existingEvidenceOwnershipDecision(
  row: { owned?: unknown } | undefined,
): ExistingEvidenceOwnership {
  if (!row) return 'absent'
  return row.owned === true ? 'owned' : 'collision'
}

/** Selects and locks an evidence id once while projecting whether this principal owns it. */
export function existingEvidenceOwnershipLookup(
  input: ExistingEvidenceOwnershipLookupInput,
): OwnedEvidenceLookup {
  const ownership = evidenceOwnershipPredicate(input)
  if (input.scope === 'space-principal') {
    return {
      text: `SELECT (${ownership.text}) AS owned
       FROM ${input.table} evidence
       LEFT JOIN machine owner_machine ON owner_machine.id=evidence.${ownerColumns[input.table]}
       WHERE evidence.id=$1::uuid FOR UPDATE OF evidence`,
      values: [input.id, ...ownership.values],
    }
  }
  if (input.table !== 'run') {
    return {
      text: `SELECT (${ownership.text}) AS owned FROM ${input.table} WHERE id=$1::uuid FOR UPDATE`,
      values: [input.id, ...ownership.values],
    }
  }
  return {
    text: `SELECT (${ownership.text}) AS owned
     FROM run WHERE id=$1::uuid FOR UPDATE`,
    values: [input.id, ...ownership.values],
  }
}

export function ownedEvidenceLookup(input: OwnedEvidenceLookupInput): OwnedEvidenceLookup {
  const ownership = evidenceOwnershipPredicate(input)
  if (input.scope === 'space-principal') {
    return {
      text: `SELECT evidence.id FROM ${input.table} evidence
       JOIN machine owner_machine ON owner_machine.id=evidence.${ownerColumns[input.table]}
       WHERE evidence.id=$1::uuid AND ${ownership.text} ${input.suffix}`,
      values: [input.id, ...ownership.values],
    }
  }
  return {
    text: `SELECT id FROM ${input.table}
     WHERE id=$1::uuid AND ${ownership.text} ${input.suffix}`,
    values: [input.id, ...ownership.values],
  }
}
