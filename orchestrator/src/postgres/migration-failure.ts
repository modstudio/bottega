type ErrorDetails = {
  cause?: unknown
  code?: unknown
  message?: unknown
  query?: unknown
}

const isObject = (value: unknown): value is ErrorDetails =>
  typeof value === 'object' && value !== null

const oneLine = (value: string): string => value.replaceAll(/\s+/g, ' ').trim()

export function migrationFailure(
  error: unknown,
  pendingMigrations: string[],
  readMigrationSql: (name: string) => string,
): string {
  const chain: ErrorDetails[] = []
  const seen = new Set<object>()
  let current = isObject(error) ? error : undefined
  while (current && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = isObject(current.cause) ? current.cause : undefined
  }

  const queryEntry = chain.find((entry) => typeof entry.query === 'string')
  const query = typeof queryEntry?.query === 'string' ? queryEntry.query : '<unknown>'
  const migration =
    pendingMigrations.find(
      (name) => query !== '<unknown>' && readMigrationSql(name).includes(query),
    ) ??
    (pendingMigrations.join(',') || '<unknown>')

  let message = String(error)
  let code: string | undefined
  for (const entry of chain) {
    if (typeof entry.message === 'string' && entry.message.trim()) message = entry.message
    if (typeof entry.code === 'string') code = entry.code
  }

  return `migration ${migration} statement ${oneLine(query)}: ${oneLine(message)}${
    code ? ` (code ${code})` : ''
  }`
}
