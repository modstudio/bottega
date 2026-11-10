// concern: hosted-config-membership-removal
/** Refuses membership changes that would leave config keys unattributed or encrypted data stranded. */
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { assertRecordMigrationsCurrent } from './record-migration-requirement.ts'
import { recordPool } from './record-pool.ts'

const claimOrRevokeRemedy = `run \`${PLATFORM_SLUG} machine config machine init --space <slug>\` on each machine to claim it, or revoke it with \`${PLATFORM_SLUG} machine config machine revoke <keyId>\`, then retry`
const preserveDekRemedy = `from one of the member's machines, trust a machine of a remaining config-access holder with \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space <slug>\` so the data key is wrapped for it, then retry`

export async function assertConfigAccessRemovalSafe(
  tx: SQL,
  spaceId: string,
  userId: string,
): Promise<void> {
  await assertRecordMigrationsCurrent(tx)

  const unattributed = await tx`
    SELECT DISTINCT k.key_id
    FROM machine_public_key k JOIN secret_dek_wrap w
      ON w.space_id=k.space_id AND w.recipient_key_id=k.key_id
    WHERE k.space_id=${spaceId}::uuid AND k.user_id IS NULL AND k.revoked_at IS NULL
    ORDER BY k.key_id
  `
  if (unattributed.length)
    throw new ConfigServiceError(
      `cannot remove config access while wrapped machine keys are unattributed: ${unattributed.map((row: Record<string, unknown>) => String(row.key_id)).join(', ')}; ${claimOrRevokeRemedy}`,
      409,
    )

  const stranded = await tx`
    SELECT version FROM record_config_access_stranded_dek_versions(${spaceId}::uuid, ${userId}::uuid)
    ORDER BY version
  `
  if (stranded.length)
    // Keep this refusal and remedy in sync with 20261103210000_dev_2097_config_access_revocation/migration.sql.
    throw new ConfigServiceError(
      `cannot remove config access because it would strand data key versions: ${stranded.map((row: Record<string, unknown>) => String(row.version)).join(', ')}; ${preserveDekRemedy}`,
      409,
    )
}

export async function ensureMemberConfigRemovalSafe(input: {
  url: string
  spaceId: string
  userId: string
}): Promise<void> {
  await recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, { spaceId: input.spaceId, userId: input.userId })
    await assertConfigAccessRemovalSafe(tx, input.spaceId, input.userId)
  })
}
