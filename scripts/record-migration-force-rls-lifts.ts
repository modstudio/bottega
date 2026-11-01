const identifier = `(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)`
const qualifiedIdentifier = String.raw`${identifier}(?:\s*\.\s*${identifier})?`
const forceChange = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(${qualifiedIdentifier})\s+(NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY\b`,
  'giu',
)
const tableReference = new RegExp(
  String.raw`\b(?:DELETE\s+FROM|UPDATE|(?<!DISTINCT\s)FROM|JOIN)\s+(?:ONLY\s+)?(${qualifiedIdentifier})`,
  'giu',
)

export type ForceRlsLiftViolation = { table: string }

function tableName(source: string): string {
  const part = source.split('.').at(-1)?.trim() ?? source
  return part.startsWith('"')
    ? part.slice(1, -1).replaceAll('""', '"').toLowerCase()
    : part.toLowerCase()
}

function dollarDelimiter(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  return sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0] ?? null
}

function singleQuotedEnd(sql: string, start: number): number {
  for (let index = start + 1; index < sql.length; index++) {
    if (sql[index] !== "'") continue
    if (sql[index + 1] === "'") index++
    else return index + 1
  }
  return sql.length
}

function migrationMaskedSpanEnd(sql: string, start: number): number | null {
  if (sql.startsWith('--', start)) {
    const newline = sql.indexOf('\n', start + 2)
    return newline < 0 ? sql.length : newline
  }
  if (sql.startsWith('/*', start)) {
    const close = sql.indexOf('*/', start + 2)
    return close < 0 ? sql.length : close + 2
  }
  if (sql[start] === "'") return singleQuotedEnd(sql, start)
  const delimiter = dollarDelimiter(sql, start)
  if (!delimiter) return null
  const close = sql.indexOf(delimiter, start + delimiter.length)
  return close < 0 ? sql.length : close + delimiter.length
}

function migrationStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  for (let index = 0; index < sql.length; index++) {
    const maskedEnd = migrationMaskedSpanEnd(sql, index)
    if (maskedEnd !== null) index = maskedEnd - 1
    else if (sql[index] === ';') {
      statements.push(sql.slice(start, index + 1))
      start = index + 1
    }
  }
  if (sql.slice(start).trim()) statements.push(sql.slice(start))
  return statements
}

function maskMigrationLiterals(sql: string): string {
  let masked = ''
  for (let index = 0; index < sql.length; index++) {
    const maskedEnd = migrationMaskedSpanEnd(sql, index)
    if (maskedEnd === null) masked += sql[index]
    else {
      masked += ' '.repeat(maskedEnd - index)
      index = maskedEnd - 1
    }
  }
  return masked
}

function migrateTimeText(statement: string, keyword: string): string {
  if (keyword !== 'DO') return maskMigrationLiterals(statement)
  const opening = /\bDO\s*(\$(?:[a-z_][a-z0-9_]*)?\$)/iu.exec(statement)
  if (!opening?.[1] || opening.index === undefined) return ''
  const bodyStart = opening.index + opening[0].length
  const bodyEnd = statement.indexOf(opening[1], bodyStart)
  if (bodyEnd < 0) return ''
  return maskMigrationLiterals(statement.slice(bodyStart, bodyEnd))
}

function leadingKeyword(statement: string): string | null {
  const withoutComments = statement
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trimStart()
  return withoutComments.match(/^([a-z]+)/i)?.[1]?.toUpperCase() ?? null
}

function forceChanges(statement: string): { table: string; lifted: boolean }[] {
  return [...statement.matchAll(forceChange)].map((match) => ({
    table: tableName(match[1]!),
    lifted: Boolean(match[2]),
  }))
}

/** Return every FORCE-RLS table set by migrate-time statements in this migration. */
export function forcedRlsTables(migrationText: string): Set<string> {
  const forced = new Set<string>()
  for (const statement of migrationStatements(migrationText)) {
    if (leadingKeyword(statement) !== 'ALTER') continue
    for (const change of forceChanges(statement)) if (!change.lifted) forced.add(change.table)
  }
  return forced
}

/** Find migrate-time reads of FORCE-RLS tables that a migration did not lift or exempt. */
export function forceRlsLiftViolations(
  migrationText: string,
  forcedTables: ReadonlySet<string>,
  exemptedTables: ReadonlySet<string> = new Set(),
): ForceRlsLiftViolation[] {
  const statements = migrationStatements(migrationText)
  const lifted = new Set<string>()
  for (const statement of statements) {
    if (leadingKeyword(statement) !== 'ALTER') continue
    for (const change of forceChanges(statement)) if (change.lifted) lifted.add(change.table)
  }
  const reads = new Set<string>()
  const migrateTimeKeywords = new Set(['DELETE', 'DO', 'INSERT', 'SELECT', 'UPDATE', 'WITH'])
  for (const statement of statements) {
    const keyword = leadingKeyword(statement) ?? ''
    if (!migrateTimeKeywords.has(keyword)) continue
    for (const match of migrateTimeText(statement, keyword).matchAll(tableReference))
      reads.add(tableName(match[1]!))
  }
  return [...reads]
    .filter((table) => forcedTables.has(table) && !lifted.has(table) && !exemptedTables.has(table))
    .sort()
    .map((table) => ({ table }))
}
