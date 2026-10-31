export class CheckFailure extends Error {}
export class MigrationFailure extends CheckFailure {}

export type RecordMigrationPhase =
  | 'reading migrations'
  | 'starting PGlite'
  | 'provisioning PGlite'
  | 'replaying migrations'
  | 'closing PGlite'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPgliteModuleResolutionFailure(error: unknown): boolean {
  const message = errorMessage(error)
  if (!message.includes('@electric-sql/pglite')) return false

  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    message.includes('Cannot find module') ||
    message.includes('Cannot find package')
  )
}

export function phaseFailure(
  phase: RecordMigrationPhase,
  error: unknown,
  rerun: string,
): CheckFailure {
  if (error instanceof MigrationFailure) return error

  const message = errorMessage(error)
  if (phase === 'starting PGlite' || isPgliteModuleResolutionFailure(error)) {
    return new CheckFailure(
      `${phase} failed: ${message}. Check that @electric-sql/pglite is installed (bun install), then rerun ${rerun}.`,
    )
  }
  if (phase === 'reading migrations') {
    return new CheckFailure(
      `${phase} failed: ${message}. Check that the migrations folder is readable, then rerun ${rerun}.`,
    )
  }
  return new CheckFailure(`${phase} failed: ${message}. Fix that cause, then rerun ${rerun}.`)
}
