// concern: machine-trust-refusal
/** Separates repairable missing registration from irrevocable machine-key revocation. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import type { TrustedKeys } from '../../../shared/trust-log-keys.ts'

type RegisteredMachineKey = { revokedAt: string | null }

const localTrustLogRemedy = (spaceSlug: string) =>
  `on this machine run \`${PLATFORM_SLUG} machine join --space ${spaceSlug}\`, then on a machine the trust log already trusts run \`${PLATFORM_SLUG} machine approve <code>\` with the code it prints`

const targetTrustLogRemedy = (spaceSlug: string) =>
  `on that machine run \`${PLATFORM_SLUG} machine join --space ${spaceSlug}\`, then on a machine the trust log already trusts run \`${PLATFORM_SLUG} machine approve <code>\` with the code it prints`

const missingLocalTrustLogKeyRefusal = (keyId: string, spaceSlug: string) =>
  renderRefusal(
    refusal(`this machine's key ${keyId} is not listed in the space's machine trust log`, {
      kind: 'edit',
      text: localTrustLogRemedy(spaceSlug),
    }),
  )

export const missingTrustLogKeyRefusal = (keyId: string, spaceSlug: string) =>
  renderRefusal(
    refusal(`the space's machine trust log does not list ${keyId}`, {
      kind: 'edit',
      text: targetTrustLogRemedy(spaceSlug),
    }),
  )

export const anchoredWrapSenderRefusal = (dekId: string, spaceSlug: string, senderKeyId: string) =>
  renderRefusal(
    refusal(
      `data key ${dekId} in record space ${spaceSlug} was wrapped by ${senderKeyId}, which the space's machine trust log does not list`,
      { kind: 'edit', text: localTrustLogRemedy(spaceSlug) },
    ),
  )

export function anchoredTrustRefusal(
  trust: { anchored: boolean; keys: TrustedKeys },
  keyIds: { local: string; target: string },
  spaceSlug: string,
): string | null {
  if (!trust.anchored) return null
  if (!trust.keys[keyIds.local]) return missingLocalTrustLogKeyRefusal(keyIds.local, spaceSlug)
  if (!trust.keys[keyIds.target]) return missingTrustLogKeyRefusal(keyIds.target, spaceSlug)
  return null
}

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
