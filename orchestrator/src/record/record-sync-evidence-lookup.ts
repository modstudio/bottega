// concern: record-sync-evidence-lookup
/** Builds the lookup for an evidence row one machine owns. Must not run SQL. */
import type {
  MachineEvidenceTable,
  SpacePrincipalEvidenceTable,
} from './record-evidence-references.ts'

export type OwnedEvidenceLookup = { text: string; values: string[] }

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

const ownerColumns: Record<SpacePrincipalEvidenceTable, string> = {
  task_flow: 'opening_machine_id',
  task_flow_stage: 'opened_machine_id',
}

export function ownedEvidenceLookup(input: OwnedEvidenceLookupInput): OwnedEvidenceLookup {
  if (input.scope === 'space-principal') {
    return {
      text: `SELECT evidence.id FROM ${input.table} evidence
       JOIN machine owner_machine ON owner_machine.id=evidence.${ownerColumns[input.table]}
       WHERE evidence.id=$1::uuid AND evidence.space_id=$2::uuid
         AND owner_machine.user_id=$3::uuid ${input.suffix}`,
      values: [input.id, input.spaceId, input.userId],
    }
  }
  const base = `SELECT id FROM ${input.table}
     WHERE id=$1::uuid AND space_id=$2::uuid AND machine_id=$3::uuid`
  const values = [input.id, input.spaceId, input.machineId]
  // Only a run carries its starting user, and Postgres refuses a parameter the statement never uses.
  if (input.table !== 'run') return { text: `${base} ${input.suffix}`, values }
  return {
    text: `${base} AND started_by_user_id=$4::uuid ${input.suffix}`,
    values: [...values, input.userId],
  }
}
