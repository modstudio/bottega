// concern: record-board-presence
/** Hosted board presence timing. SQL functions carry matching literal intervals. */

import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'
import type { HostedBoardPresenceInput } from './record-board-contract.ts'

export const BOARD_PRESENCE_WRITE_INTERVAL_MS = 5 * 60 * 1000
export const BOARD_PRESENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export async function upsertHostedBoardPresence(
  tx: SQL,
  input: {
    spaceId: string
    userId: string
    machineId?: string | null
    presence?: HostedBoardPresenceInput[]
  },
): Promise<void> {
  for (const row of input.presence ?? []) {
    await tx`
      INSERT INTO board_presence
        (id, space_id, user_id, session, project_id, role, machine_id, first_seen, last_seen)
      VALUES (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${input.userId}::uuid,
        ${row.session}, ${row.projectId}::uuid, ${row.role}, ${input.machineId ?? null}::uuid,
        ${row.firstSeen}::timestamptz, ${row.lastSeen}::timestamptz)
      ON CONFLICT (space_id, session) DO UPDATE SET
        user_id=EXCLUDED.user_id, project_id=EXCLUDED.project_id, role=EXCLUDED.role,
        machine_id=EXCLUDED.machine_id, first_seen=LEAST(board_presence.first_seen, EXCLUDED.first_seen),
        last_seen=EXCLUDED.last_seen
      WHERE board_presence.last_seen < EXCLUDED.last_seen - (${BOARD_PRESENCE_WRITE_INTERVAL_MS} * interval '1 millisecond')
    `
  }
}
