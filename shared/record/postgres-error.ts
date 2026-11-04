// concern: postgres-error
/** Reads SQLSTATE and server message from a Bun SQL error. */

export function postgresErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = 'cause' in current ? current.cause : null
  }
  return chain
}

export function postgresSqlState(error: unknown): string | null {
  for (const item of postgresErrorChain(error)) {
    const candidate = item as { code?: unknown; errno?: unknown }
    for (const value of [candidate.errno, candidate.code]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const normalized = String(value).toUpperCase()
      if (/^[0-9A-Z]{5}$/.test(normalized)) return normalized
    }
  }
  return null
}

export function postgresServerMessage(error: unknown): string {
  for (const item of postgresErrorChain(error)) {
    const candidate = item as { code?: unknown }
    if (candidate.code === 'ERR_POSTGRES_SERVER_ERROR' && item instanceof Error) return item.message
  }
  return error instanceof Error ? error.message : String(error)
}
