// concern: hosted-record-migration-requirement
/** Refuses record operations whose shipped schema requirements are not yet applied. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordMigrationCount } from '../postgres/postgres-migrate.ts'

export async function assertRecordMigrationsCurrent(tx: SQL): Promise<void> {
  const available = await tx`
    SELECT to_regprocedure('record_applied_migration_count()') IS NOT NULL AS available
  `
  if (!available[0]?.available) {
    throw new Error(
      `record migrations are behind this command; run \`${PLATFORM_SLUG} record migrate\`, then retry`,
    )
  }
  const applied = await tx`SELECT record_applied_migration_count() AS count`
  const appliedCount = Number(applied[0]?.count ?? 0)
  const shippedCount = recordMigrationCount()
  if (appliedCount !== shippedCount) {
    throw new Error(
      `record migrations are behind this command (applied ${appliedCount}, shipped ${shippedCount}); run \`${PLATFORM_SLUG} record migrate\`, then retry`,
    )
  }
}
