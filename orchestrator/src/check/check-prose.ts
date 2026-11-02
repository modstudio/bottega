// concern: commit message prose check
/** Extracts authored commit text and runs the shared write gate. */

import { readFileSync } from 'node:fs'
import { proseGate } from '../../../shared/prose/prose-gate.ts'
import { proseCheckEnabled } from '../prose-service.ts'

const SCISSORS = '# ------------------------ >8 ------------------------'

export function commitMessageText(message: string): string {
  const lines: string[] = []
  for (const line of message.split(/\r?\n/)) {
    if (line === SCISSORS) break
    if (!line.startsWith('#')) lines.push(line)
  }
  return lines.join('\n').trim()
}

export async function checkCommitMessageProse(path: string | undefined): Promise<number> {
  if (!path) {
    console.error('commit-msg: message path is required')
    return 1
  }
  const result = await proseGate(
    [{ field: 'commit message', text: commitMessageText(readFileSync(path, 'utf8')), prior: null }],
    { displayName: null, enabled: proseCheckEnabled() },
  )
  for (const notice of result.notices) console.error(notice)
  if (!result.refusal) return 0
  console.error(result.refusal)
  return 3
}
