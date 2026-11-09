// concern: hosted-config-refusals
/** The typed refusal shared by hosted-config services and API error rendering. */
export class ConfigServiceError extends Error {
  status: 400 | 403 | 404 | 409 | 422
  constructor(message: string, status: 400 | 403 | 404 | 409 | 422) {
    super(message)
    this.status = status
  }
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false
  const postgres = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown }
  const message = error instanceof Error ? error.message : ''
  const named =
    postgres.constraint === constraint ||
    postgres.constraint_name === constraint ||
    message.includes(`"${constraint}"`)
  return named && (postgres.code === '23505' || message.includes('duplicate key value'))
}
