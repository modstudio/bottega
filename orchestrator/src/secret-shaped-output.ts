// concern: secret-shaped-output
/** Line-level withholding of secret-shaped recorded output. Detection stays in shared/. */

import { secretShapedRule } from '../../shared/secret-shaped.ts'

/** Replace each secret-shaped line; keep the rest so a failure summary survives. */
export function withholdSecretShapedGateLines(output: string): string {
  return output
    .split('\n')
    .map((line) => {
      const rule = secretShapedRule(line)
      return rule === null ? line : `[withheld line: ${rule}]`
    })
    .join('\n')
}
