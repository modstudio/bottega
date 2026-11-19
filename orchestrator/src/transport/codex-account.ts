// concern: codex account identity
/** Reads only Codex's non-secret account identity from its authentication file. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Malformed JSON and documents without a string account id have no account identity. */
export function parseCodexAccountId(text: string): string | null {
  try {
    const accountId = (JSON.parse(text) as { tokens?: { account_id?: unknown } }).tokens?.account_id
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
  } catch {
    return null
  }
}

/** Missing or unreadable authentication files have no account identity. */
export function readCodexAccountId(codexHome: string): string | null {
  try {
    return parseCodexAccountId(readFileSync(join(codexHome, 'auth.json'), 'utf8'))
  } catch {
    return null
  }
}
