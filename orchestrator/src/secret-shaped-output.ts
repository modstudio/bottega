// concern: secret-shaped-output
/** Line-level withholding of secret-shaped recorded output. Detection stays in shared/. */

import { evidenceSecretShapedRules } from '../../shared/secret-shaped.ts'

/** Replace each secret-shaped line; keep the rest so a failure summary survives. */
export function withholdSecretShapedLines(output: string): string {
  return output
    .split('\n')
    .map((line) => {
      const rule = evidenceSecretShapedRules(line)[0] ?? null
      return rule === null ? line : `[withheld line: ${rule}]`
    })
    .join('\n')
}
