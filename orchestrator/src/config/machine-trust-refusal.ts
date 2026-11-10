// concern: machine-trust-refusal
/** Separates repairable missing registration from irrevocable machine-key revocation. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

type RegisteredMachineKey = { revokedAt: string | null }

export function machineTrustRefusal(
  keyId: string,
  registered: RegisteredMachineKey | undefined,
): string | null {
  if (!registered)
    return `machine key ${keyId} is not registered in this space; on that machine run \`${PLATFORM_SLUG} machine config machine register\`, then trust it again`
  if (registered.revokedAt)
    return `machine key ${keyId} was revoked in this space and cannot be trusted again; on that machine run \`${PLATFORM_SLUG} machine config machine init\` to make a new key, then \`${PLATFORM_SLUG} machine config machine register\`, and trust the new key`
  return null
}
