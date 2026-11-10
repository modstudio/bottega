// concern: machine-trust-refusal
/** Separates repairable missing registration from irrevocable machine-key revocation. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

type RegisteredMachineKey = { revokedAt: string | null }

export function machineTrustRefusal(
  keyId: string,
  registered: RegisteredMachineKey | undefined,
  spaceSlug: string,
): string | null {
  const spaceOption = ` --space ${spaceSlug}`
  const registerCommand = `${PLATFORM_SLUG} machine config machine register${spaceOption}`
  const trustCommand = `${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>${spaceOption}`
  const trustAgain = `trust it again with \`${trustCommand}\``
  const trustNewKey = `trust the new key with \`${trustCommand}\``
  if (!registered)
    return renderRefusal(
      refusal(`machine key ${keyId} is not registered in this space`, {
        kind: 'edit',
        text: `on that machine run \`${registerCommand}\`, then ${trustAgain}`,
      }),
    )
  if (registered.revokedAt)
    return renderRefusal(
      refusal(`machine key ${keyId} was revoked in this space and cannot be trusted again`, {
        kind: 'edit',
        text: `on that machine run \`${PLATFORM_SLUG} machine config machine init${spaceOption}\` to make a new key, then \`${registerCommand}\`, and ${trustNewKey}`,
      }),
    )
  return null
}
