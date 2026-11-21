// concern: outbox-held-contract
/** Owns the hosted/local held-for-upgrade marker and refusal contract. The marker must lead every held message. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const OUTBOX_HELD_FOR_UPGRADE_MARKER = 'outbox-held-for-upgrade:'
export const HOSTED_API_RELEASE_COMMAND = `${PLATFORM_SLUG} release run ${PLATFORM_SLUG} --rung hosted-api`

const UNKNOWN_COLUMNS_LABEL = ' outbox payload has unknown columns: '
const RETIRE_COMMAND = `${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text>`

function heldRemedies(): string {
  return `the hosted record API predates this client; run \`${HOSTED_API_RELEASE_COMMAND}\` to clear it, or retire the row with \`${RETIRE_COMMAND}\``
}

export function outboxHeldForUpgradeLikePattern(): string {
  return `${OUTBOX_HELD_FOR_UPGRADE_MARKER}%`
}

export function outboxHeldUnknownColumns(reason: string): string {
  const start = reason.indexOf(UNKNOWN_COLUMNS_LABEL)
  if (!reason.startsWith(OUTBOX_HELD_FOR_UPGRADE_MARKER) || start < 0) return 'unknown'
  const columnsStart = start + UNKNOWN_COLUMNS_LABEL.length
  const end = reason.indexOf(';', columnsStart)
  return reason.slice(columnsStart, end < 0 ? undefined : end)
}

export class HostedApiUpgradeRequiredError extends Error {
  readonly kind: string
  readonly columns: readonly string[]

  constructor(kind: string, columns: readonly string[], heldSubject?: string) {
    const sorted = [...columns].sort()
    const subject = heldSubject ?? `${kind}${UNKNOWN_COLUMNS_LABEL}${sorted.join(', ')}`
    super(`${OUTBOX_HELD_FOR_UPGRADE_MARKER} ${subject}; ${heldRemedies()}`)
    this.name = 'HostedApiUpgradeRequiredError'
    this.kind = kind
    this.columns = sorted
  }

  static unknownKind(kind: string): HostedApiUpgradeRequiredError {
    return new HostedApiUpgradeRequiredError(kind, [], `unknown outbox kind: ${kind}`)
  }
}
