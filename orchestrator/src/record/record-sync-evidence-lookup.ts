// concern: record-sync-evidence-lookup
/** Builds the lookup for an evidence row one machine owns. Must not run SQL. */

export type OwnedEvidenceLookup = { text: string; values: string[] }

export function ownedEvidenceLookup(input: {
  table: string
  id: string
  spaceId: string
  machineId: string
  userId: string
  suffix: string
  scope: 'machine' | 'space-principal'
}): OwnedEvidenceLookup {
  if (input.scope === 'space-principal') {
    const ownerColumn = input.table === 'task_flow' ? 'opening_machine_id' : 'opened_machine_id'
    return {
      text: `SELECT evidence.id FROM ${input.table} evidence
       JOIN machine owner_machine ON owner_machine.id=evidence.${ownerColumn}
       WHERE evidence.id=$1::uuid AND evidence.space_id=$2::uuid
         AND $3::uuid IS NOT NULL ${input.suffix}`,
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
