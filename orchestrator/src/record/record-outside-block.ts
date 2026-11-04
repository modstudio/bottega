// concern: record-outside-block
/** Owns owner moderation of outside authors in the active space. */

import type { SQL } from 'bun'
import { formatNoteLabel, type NoteLabel } from '../../../shared/note-label.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { requireOwner } from './record-outside-intake.ts'
import { recordPool } from './record-pool.ts'
import type { RecordRowTarget } from './record-row-target.ts'

type Tenant = { url: string } & TenantPrincipal
export type OutsideBlock = {
  userId: string
  blockedUntil: string | null
  blockedByUserId: string
  createdAt: string
}

async function tenant<T>(input: Tenant, run: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return run(tx)
  })
}

function blockFromRow(row: Record<string, unknown>): OutsideBlock {
  return {
    userId: String(row.user_id),
    blockedUntil: row.blocked_until ? new Date(String(row.blocked_until)).toISOString() : null,
    blockedByUserId: String(row.blocked_by_user_id),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }
}

async function messageAuthor(tx: SQL, spaceId: string, message: string): Promise<string> {
  const rows = await tx`
    SELECT m.author_user_id
    FROM board_message m
    WHERE m.id=${message}::uuid AND EXISTS (
      SELECT 1 FROM unnest(m.scope_project_ids) scoped(project_id)
      JOIN project p ON p.id=scoped.project_id
      WHERE p.space_id=${spaceId}::uuid
    )
  `
  if (!rows[0]) throw new ConfigServiceError(`no board message ${message} in the active space`, 404)
  return String(rows[0].author_user_id)
}

async function noteAuthor(tx: SQL, spaceId: string, note: NoteLabel): Promise<string> {
  const label = formatNoteLabel(note.project, note.number)
  const rows = await tx`
    SELECT author_user_id
    FROM hub_note
    WHERE space_id=${spaceId}::uuid AND project_name=${note.project}
      AND number=${note.number} AND deleted_at IS NULL
  `
  if (!rows[0]) throw new ConfigServiceError(`no note ${label} in the active space`, 404)
  if (!rows[0].author_user_id)
    throw new ConfigServiceError(`note ${label} has no hosted author to block`, 400)
  return String(rows[0].author_user_id)
}

export async function blockOutsideAuthor(
  input: Tenant & RecordRowTarget & { hours?: number },
): Promise<OutsideBlock> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'blocking an outside author')
    const author = input.message
      ? await messageAuthor(tx, input.spaceId, input.message)
      : await noteAuthor(tx, input.spaceId, input.note!)
    const memberships = await tx`
      SELECT 1 FROM membership WHERE space_id=${input.spaceId}::uuid AND user_id=${author}::uuid
    `
    if (memberships[0])
      throw new ConfigServiceError(
        `${author} is a member of this space; blocks apply only to outside authors`,
        409,
      )
    const rows = await tx`
      INSERT INTO space_posting_block
        (id,space_id,user_id,blocked_until,blocked_by_user_id,created_at)
      VALUES (
        ${newRecordId()}::uuid,${input.spaceId}::uuid,${author}::uuid,
        ${input.hours === undefined ? null : input.hours}::int * interval '1 hour' +
          CASE WHEN ${input.hours === undefined} THEN NULL ELSE now() END,
        ${input.userId}::uuid,now()
      )
      ON CONFLICT ON CONSTRAINT space_posting_block_space_user_unique DO UPDATE
      SET blocked_until=EXCLUDED.blocked_until,
          blocked_by_user_id=EXCLUDED.blocked_by_user_id,
          created_at=EXCLUDED.created_at
      RETURNING user_id,blocked_until,blocked_by_user_id,created_at
    `
    return blockFromRow(rows[0])
  })
}

export async function listOutsideBlocks(input: Tenant): Promise<OutsideBlock[]> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'listing outside-author blocks')
    const rows = await tx`
      SELECT user_id,blocked_until,blocked_by_user_id,created_at
      FROM space_posting_block
      WHERE space_id=${input.spaceId}::uuid
      ORDER BY created_at DESC
    `
    return rows.map(blockFromRow)
  })
}

export async function unblockOutsideAuthor(
  input: Tenant & { blockedUserId: string },
): Promise<void> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'unblocking an outside author')
    const rows = await tx`
      DELETE FROM space_posting_block
      WHERE space_id=${input.spaceId}::uuid AND user_id=${input.blockedUserId}::uuid
      RETURNING id
    `
    if (!rows[0])
      throw new ConfigServiceError(
        `no block for user ${input.blockedUserId} in the active space`,
        404,
      )
  })
}
