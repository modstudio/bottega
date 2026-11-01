// concern: record-space-move
/** Owns the atomic hosted move of one project's attributable rows. */

import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordSpaceMembership } from '../../../shared/record-space-membership.ts'
import { recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { recordPool } from './record-pool.ts'
import { currentRecordUserSession } from './record-session.ts'
import type { RecordMembership } from './record-space.ts'

type ProjectSpaceMoveRow = {
  tableName: string
  reachedBy: string
  rowCount: number
  moved: boolean
}

export type ProjectSpaceMoveResult = {
  destinationSlug: string
  rows: ProjectSpaceMoveRow[]
  total: number
}

export function destinationOwnedByCaller(
  value: string,
  memberships: readonly RecordMembership[],
): RecordMembership {
  const destination = recordSpaceMembership(value, memberships)
  if (!destination) {
    throw new Error(
      `destination record space ${value} does not exist or is not visible to the caller; create it or join it as owner, then retry`,
    )
  }
  if (destination.role !== 'owner') {
    throw new Error(
      `destination record space ${value} requires the owner role; ask its owner to promote the caller, then retry`,
    )
  }
  return destination
}

export function requireCurrentMoveTotal(confirmed: number | undefined, current: number): void {
  if (confirmed !== undefined && confirmed !== current) {
    throw new Error(
      `confirmation count ${confirmed} does not match current total ${current}; run the dry run again`,
    )
  }
}

export async function moveRecordProjectSpace(input: {
  url: string
  project: string
  source?: string
  destination: string
  confirm?: number
}): Promise<ProjectSpaceMoveResult> {
  const current = await currentRecordUserSession(input.url)
  const membershipRows = await recordPool(input.url).begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
    await tx`SELECT set_config('app.space_id', ${current.activeSpaceId ?? ''}, true)`
    return tx`
        SELECT s.id AS space_id, s.name, s.slug, m.role, m.permission
        FROM membership m JOIN space s ON s.id=m.space_id
        WHERE m.user_id=${current.user.id}::uuid ORDER BY s.slug
      `
  })
  const listed = membershipRows.map((row: Record<string, unknown>) => ({
    spaceId: String(row.space_id),
    name: String(row.name),
    slug: String(row.slug),
    role: String(row.role),
    permission: String(row.permission),
  }))
  const destination = destinationOwnedByCaller(input.destination, listed)
  const source = input.source ?? current.activeSpaceId
  if (!source) {
    throw new Error(
      `record session has no active source space; run \`${PLATFORM_SLUG} record space switch <slug>\``,
    )
  }

  // record_move_project_space leaves session-lifetime temp tables behind, so a
  // pooled connection would refuse the next move; this client lives for one move.
  const client = new SQL(input.url, { max: 1 })
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${source}, true)`
      const available = await tx`
          SELECT to_regprocedure('record_applied_migration_count()') IS NOT NULL AS available
        `
      if (!available[0]?.available) {
        throw new Error(
          `record migrations are behind this command; run \`${PLATFORM_SLUG} record migrate\`, then retry`,
        )
      }
      const applied = await tx`SELECT record_applied_migration_count() AS count`
      const shipped = recordMigrationCount()
      if (Number(applied[0]?.count ?? 0) !== shipped) {
        throw new Error(
          `record migrations are behind this command (applied ${Number(applied[0]?.count ?? 0)}, shipped ${shipped}); run \`${PLATFORM_SLUG} record migrate\`, then retry`,
        )
      }
      const rows = await tx`
          SELECT * FROM record_move_project_space(
            ${source}, ${input.project}, ${destination.spaceId}, ${input.confirm ?? null}::bigint
          )
        `
      const resultRows: ProjectSpaceMoveRow[] = rows.map((row: Record<string, unknown>) => ({
        tableName: String(row.table_name),
        reachedBy: String(row.reached_by),
        rowCount: Number(row.row_count),
        moved: Boolean(row.moved),
      }))
      const total = resultRows.reduce((sum, row) => sum + row.rowCount, 0)
      requireCurrentMoveTotal(input.confirm, total)
      return { destinationSlug: destination.slug, rows: resultRows, total }
    })
  } finally {
    await client.close()
  }
}
