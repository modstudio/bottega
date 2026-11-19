// concern: codex account identity
/** Reads only Codex's non-secret account identity from its authentication file. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { USER_CANON_HOME_MAPPINGS } from '../../../shared/user-canon-home.ts'

const CODEX_HOME_MAPPING = USER_CANON_HOME_MAPPINGS.find((mapping) => mapping.harness === 'codex')!

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

/** Resolves the account source declared for a quota-reading harness. */
export function currentQuotaAccountId(
  harness: string | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  if (harness !== CODEX_HOME_MAPPING.harness) return null
  const override = CODEX_HOME_MAPPING.homeOverrideEnvironment
  const codexHome = (override && env[override]) || join(home, CODEX_HOME_MAPPING.defaultDirectory)
  return readCodexAccountId(codexHome)
}
