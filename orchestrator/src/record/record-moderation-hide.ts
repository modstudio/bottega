// concern: record-moderation-hide
/** Owns owner hiding of board messages and notes in the active space. */

import type { SQL } from 'bun'
import type { ModerationHideReason } from '../../../shared/moderation-hide-reason.ts'
import { formatNoteLabel } from '../../../shared/note-label.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { requireOwner } from './record-outside-intake.ts'
import { recordPool } from './record-pool.ts'
import type { RecordRowTarget } from './record-row-target.ts'

type Tenant = { url: string } & TenantPrincipal
export type HiddenRow =
  | {
      kind: 'message'
      id: string
      authorUserId: string
      hiddenByUserId: string
      reason: ModerationHideReason
      hiddenAt: string
    }
  | {
      kind: 'note'
      id: string
      label: string
      authorUserId: string | null
      hiddenByUserId: string
      reason: ModerationHideReason
      hiddenAt: string
    }

async function tenant<T>(input: Tenant, run: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return run(tx)
  })
}

function hiddenFromRow(row: Record<string, unknown>): HiddenRow {
  const hiddenAt = row.hidden_at instanceof Date ? row.hidden_at : recordDate(row.hidden_at)
  const common = {
    id: String(row.id),
    authorUserId: row.author_user_id == null ? null : String(row.author_user_id),
    hiddenByUserId: String(row.hidden_by_user_id),
    reason: String(row.hidden_reason) as ModerationHideReason,
    hiddenAt: hiddenAt.toISOString(),
  }
  return row.kind === 'message'
    ? { ...common, kind: 'message', authorUserId: common.authorUserId! }
    : {
        ...common,
        kind: 'note',
        label: formatNoteLabel(String(row.project_name), Number(row.number)),
      }
}

async function targetRow(tx: SQL, spaceId: string, target: RecordRowTarget) {
  if (target.message) {
    const rows = await tx`
      SELECT 'message' kind,m.id,m.author_user_id,m.hidden_at,m.hidden_by_user_id,m.hidden_reason
      FROM board_message m
      WHERE m.id=${target.message}::uuid AND EXISTS (
        SELECT 1 FROM unnest(m.scope_project_ids) scoped(project_id)
        JOIN project p ON p.id=scoped.project_id
        WHERE p.space_id=${spaceId}::uuid
      )
    `
    if (!rows[0]) {
      const shared = await tx`
        SELECT shared_space_reach FROM board_message WHERE id=${target.message}::uuid
      `
      if (shared[0]?.shared_space_reach)
        throw new ConfigServiceError('a notice that reaches shared spaces cannot be hidden', 400)
      throw new ConfigServiceError(`no board message ${target.message} in the active space`, 404)
    }
    return rows[0]
  }
  const label = formatNoteLabel(target.note!.project, target.note!.number)
  const rows = await tx`
    SELECT 'note' kind,id,project_name,number,author_user_id,hidden_at,hidden_by_user_id,hidden_reason
    FROM hub_note
    WHERE space_id=${spaceId}::uuid AND project_name=${target.note!.project}
      AND number=${target.note!.number} AND deleted_at IS NULL
  `
  if (!rows[0]) throw new ConfigServiceError(`no note ${label} in the active space`, 404)
  return rows[0]
}

export async function hideRow(
  input: Tenant & RecordRowTarget & { reason: ModerationHideReason },
): Promise<HiddenRow> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'hiding a row')
    const row = await targetRow(tx, input.spaceId, input)
    if (row.hidden_at)
      throw new ConfigServiceError(
        `${row.kind === 'message' ? `board message ${row.id}` : `note ${formatNoteLabel(String(row.project_name), Number(row.number))}`} is already hidden`,
        409,
      )
    if (row.kind === 'message') {
      const rows = await tx`SELECT * FROM public.board_message_set_hidden(
        ${String(row.id)}::uuid,${input.reason},${input.userId}::uuid
      )`
      return hiddenFromRow({ ...rows[0], kind: 'message' })
    }
    const rows = await tx`SELECT * FROM public.hub_note_set_hidden(
      ${String(row.id)}::uuid,${input.reason},${input.userId}::uuid
    )`
    return hiddenFromRow(rows[0])
  })
}

export async function unhideRow(input: Tenant & RecordRowTarget): Promise<void> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'unhiding a row')
    const row = await targetRow(tx, input.spaceId, input)
    const description =
      row.kind === 'message'
        ? `board message ${row.id}`
        : `note ${formatNoteLabel(String(row.project_name), Number(row.number))}`
    if (!row.hidden_at) throw new ConfigServiceError(`${description} is not hidden`, 409)
    if (row.kind === 'message') {
      await tx`SELECT public.board_message_set_hidden(
        ${String(row.id)}::uuid,NULL,${input.userId}::uuid
      )`
      return
    }
    await tx`SELECT public.hub_note_set_hidden(
      ${String(row.id)}::uuid,NULL,${input.userId}::uuid
    )`
  })
}

export async function listHidden(input: Tenant): Promise<HiddenRow[]> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'listing hidden rows')
    const rows = await tx`
      SELECT 'message' kind,m.id,NULL::text project_name,NULL::bigint number,m.author_user_id,
        m.hidden_at,m.hidden_by_user_id,m.hidden_reason
      FROM board_message m
      WHERE m.hidden_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest(m.scope_project_ids) scoped(project_id)
        JOIN project p ON p.id=scoped.project_id WHERE p.space_id=${input.spaceId}::uuid
      )
      UNION ALL
      SELECT 'note' kind,n.id,n.project_name,n.number,n.author_user_id,n.hidden_at,
        n.hidden_by_user_id,n.hidden_reason
      FROM hub_note n
      WHERE n.space_id=${input.spaceId}::uuid AND n.hidden_at IS NOT NULL AND n.deleted_at IS NULL
      ORDER BY hidden_at DESC
    `
    return rows.map(hiddenFromRow)
  })
}
