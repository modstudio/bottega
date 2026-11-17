// concern: hosted-config-refusals
/** The typed refusal shared by hosted-config services and API error rendering. */
export class ConfigServiceError extends Error {
  status: 400 | 403 | 404 | 409 | 410 | 422 | 429
  constructor(message: string, status: 400 | 403 | 404 | 409 | 410 | 422 | 429) {
    super(message)
    this.status = status
  }
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const postgres = current as {
      cause?: unknown
      code?: unknown
      constraint?: unknown
      constraint_name?: unknown
    }
    const message = current instanceof Error ? current.message : ''
    const named =
      postgres.constraint === constraint ||
      postgres.constraint_name === constraint ||
      message.includes(`"${constraint}"`)
    if (named && (postgres.code === '23505' || message.includes('duplicate key value'))) return true
    current = postgres.cause
  }
  return false
}
