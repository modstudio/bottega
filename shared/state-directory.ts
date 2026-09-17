import { isAbsolute, join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'

export type StateEnvironment = Record<string, string | undefined>

/** The platform-specific override name is derived from the one canonical slug. */
export const STATE_HOME_ENV = `${PLATFORM_SLUG.toUpperCase()}_STATE_HOME`

/** Resolve the per-user state root using only the supplied environment. */
export function resolveStateRoot(env: StateEnvironment): string {
  const override = env[STATE_HOME_ENV]
  if (override) return override
  const xdg = env.XDG_STATE_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, PLATFORM_SLUG)
  const home = env.HOME
  if (!home) throw new Error(`cannot resolve ${PLATFORM_SLUG} state directory: HOME is not set`)
  return join(home, '.local', 'state', PLATFORM_SLUG)
}

/** Thin production wrapper; tests call resolveStateRoot with an explicit environment. */
function stateRoot(): string {
  return resolveStateRoot(process.env as StateEnvironment)
}

export function concernStateDirectory(
  concern: 'orchestrator' | 'hub',
  env?: StateEnvironment,
): string {
  return join(env ? resolveStateRoot(env) : stateRoot(), concern)
}

export type LegacyStoreMove = {
  legacyStore: string
  destinationStore: string
  legacyRuns?: string
  destinationRuns?: string
}

/** Pure refusal decision shared by both stores; callers supply filesystem facts. */
export function legacyStoreRefusal(
  defaultStoreExists: boolean,
  legacyStoreExists: boolean,
  move: LegacyStoreMove,
): string | null {
  if (defaultStoreExists || !legacyStoreExists) return null
  const paths = [
    [move.legacyStore, move.destinationStore],
    [`${move.legacyStore}-wal`, `${move.destinationStore}-wal`],
    [`${move.legacyStore}-shm`, `${move.destinationStore}-shm`],
    ...(move.legacyRuns && move.destinationRuns
      ? ([[move.legacyRuns, move.destinationRuns]] as const)
      : []),
  ]
  return (
    `refusing to create or open an empty state store while the legacy store exists\n` +
    `move the existing state before retrying (sidecars and runs when present):\n` +
    paths.map(([source, destination]) => `  ${source} -> ${destination}`).join('\n')
  )
}

if (import.meta.main) {
  const concern = process.argv[2]
  if (concern !== 'orchestrator' && concern !== 'hub') {
    throw new Error('working form: bun shared/state-directory.ts <orchestrator|hub>')
  }
  console.log(concernStateDirectory(concern))
}
