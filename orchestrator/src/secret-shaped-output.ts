// concern: secret-shaped-output
/** Span redaction of secret-shaped recorded output. Detection stays in shared/. */

import { redactSecretShaped } from '../../shared/secret-shaped.ts'

/** Redact secret-shaped spans while keeping the rest of a failure summary. */
export function redactSecretShapedOutput(
  output: string,
  knownIdentifiers: readonly string[] = [],
): string {
  return redactSecretShaped(output, { knownCommits: knownIdentifiers }).text
}
