// concern: heartbeat-guidance
/** Pure rendering shared by product guidance and the release-install proof. */

import { shellQuote } from './shell-quote.ts'

export function renderedBoardHeartbeatGuidance(input: {
  session: string
  script: string
  distributionExecutable: string | null
}): string {
  if (input.distributionExecutable) {
    return `Arm under Monitor: BOTTEGA_BIN=${shellQuote(input.distributionExecutable)} ${input.script} ${input.session}`
  }
  return `Arm under Monitor from the main checkout: ${input.script} ${input.session}`
}
