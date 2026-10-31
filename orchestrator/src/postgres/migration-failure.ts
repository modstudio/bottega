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
  const candidate = isObject(error) ? error : undefined
  const cause = candidate && isObject(candidate.cause) ? candidate.cause : undefined
  const query =
    typeof candidate?.query === 'string'
      ? candidate.query
      : typeof cause?.query === 'string'
        ? cause.query
        : '<unknown>'
  const migration =
    pendingMigrations.find(
      (name) => query !== '<unknown>' && readMigrationSql(name).includes(query),
    ) ??
    (pendingMigrations.join(',') || '<unknown>')

  let message = String(error)
  let code: string | undefined
  let current = candidate
  while (current) {
    if (typeof current.message === 'string' && current.message.trim()) message = current.message
    if (typeof current.code === 'string') code = current.code
    current = isObject(current.cause) ? current.cause : undefined
  }

  return `migration ${migration} statement ${oneLine(query)}: ${oneLine(message)}${
    code ? ` (code ${code})` : ''
  }`
}
