// concern: hosted config data-key rotation policy

import type { ConfigSecret, DataKey } from '../../../shared/config-client.ts'

export type RotationPlan = { reseal: ConfigSecret[]; retireDekIds: string[] }

export function shouldRotateAfterRevocation(
  current: DataKey,
  revocations: readonly { revokedAt: string | null }[],
): boolean {
  return revocations.some(
    ({ revokedAt }) =>
      revokedAt !== null && new Date(revokedAt).getTime() > new Date(current.createdAt).getTime(),
  )
}

export function planRotation(
  rows: ConfigSecret[],
  current: DataKey,
  keys: DataKey[],
): RotationPlan {
  const reseal = rows.filter((row) => row.dekId !== current.id)
  return {
    reseal,
    retireDekIds: keys
      .filter((key) => key.version < current.version && !key.retiredAt)
      .map((key) => key.id)
      .sort(),
  }
}
