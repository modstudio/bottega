// concern: doc-secret-scan
/** Applies secret-scan outcomes to a document write without knowing its storage adapter. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type SecretScanner, scanTextForSecrets } from '../secret-scan/secret-scan.ts'
import type { SecretScanOutcome } from '../secret-scan/secret-scan-decision.ts'

type DocAddress = { scope: string; subject: string | null; slug: string; body: string }
type WithWriteWarnings = { writeWarnings?: string[] }

const addressOf = (input: DocAddress) => `${input.scope}/${input.subject ?? '_'}/${input.slug}`
export const DOC_SECRET_SCANNER_KEY = Symbol.for('orch.doc-secret-scanner')
const scannerHolder = globalThis as typeof globalThis & {
  [DOC_SECRET_SCANNER_KEY]?: SecretScanner
}

export const defaultDocSecretScanner: SecretScanner = (body) =>
  scannerHolder[DOC_SECRET_SCANNER_KEY]?.(body) ?? scanTextForSecrets(body)

export function secretScanRefusal(
  input: DocAddress,
  outcome: Extract<SecretScanOutcome, { status: 'found' }>,
): string {
  const findings = outcome.findings
    .map(({ ruleId, line }) => `${ruleId} at line ${line}`)
    .join(', ')
  return (
    `secret scan refused ${addressOf(input)}: ${findings}\n` +
    `cleared by: remove the credential; keep it with ${PLATFORM_SLUG} machine config secret set, ` +
    'the keychain, or ~/.claude/.env, and reference it by name'
  )
}

export function scanDocBody(input: DocAddress, scanSecrets: SecretScanner): SecretScanOutcome {
  const outcome = scanSecrets(input.body)
  if (outcome.status !== 'found') return outcome
  throw new Error(secretScanRefusal(input, outcome))
}

export function addSecretScanWarning<T extends object>(
  written: T,
  input: DocAddress,
  outcome: SecretScanOutcome,
): T & WithWriteWarnings {
  if (outcome.status !== 'unavailable') return written
  return {
    ...written,
    writeWarnings: [
      ...((written as WithWriteWarnings).writeWarnings ?? []),
      `secret scan could not run for ${addressOf(input)}: ${outcome.reason}; write allowed unchecked`,
    ],
  }
}
