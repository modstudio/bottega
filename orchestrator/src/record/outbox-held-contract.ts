// concern: outbox-held-contract
/** Owns the hosted/local held-for-upgrade marker and refusal contract. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const OUTBOX_HELD_FOR_UPGRADE_MARKER = 'outbox-held-for-upgrade:'

export class HostedApiUpgradeRequiredError extends Error {
  readonly kind: string
  readonly columns: readonly string[]

  constructor(kind: string, columns: readonly string[]) {
    const sorted = [...columns].sort()
    super(
      `${OUTBOX_HELD_FOR_UPGRADE_MARKER} ${kind} outbox payload has unknown columns: ${sorted.join(', ')}; the hosted record API predates this client; run \`${PLATFORM_SLUG} release run ${PLATFORM_SLUG} --rung hosted-api\` to clear it`,
    )
    this.name = 'HostedApiUpgradeRequiredError'
    this.kind = kind
    this.columns = sorted
  }
}
