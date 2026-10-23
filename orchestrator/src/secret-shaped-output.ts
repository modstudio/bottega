// concern: secret-shaped-output
/** Line-level withholding of secret-shaped recorded output. Detection stays in shared/. */

import { secretShapedRule } from '../../shared/secret-shaped.ts'

/** Replace each secret-shaped line; keep the rest so a failure summary survives. */
export function withholdSecretShapedLines(
  output: string,
  knownIdentifiers: readonly string[] = [],
): string {
  return output
    .split('\n')
    .map((line) => {
      const candidate = knownIdentifiers.reduce(
        (text, identifier) => (identifier ? text.replaceAll(identifier, '') : text),
        line,
      )
      const rule = secretShapedRule(candidate)
      return rule === null ? line : `[withheld line: ${rule}]`
    })
    .join('\n')
}
