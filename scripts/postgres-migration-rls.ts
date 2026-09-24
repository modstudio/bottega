export type ForcedRlsDmlFinding = {
  table: string
  operation: 'DELETE' | 'EXECUTE' | 'INSERT' | 'UPDATE'
  reason:
    | 'force-enabled'
    | 'force-not-restored'
    | 'dynamic-sql-force-enabled'
    | 'dynamic-sql-force-not-restored'
}

export type ForcedRlsMigrationAnalysis = {
  findings: ForcedRlsDmlFinding[]
  forcedTables: Set<string>
}

type MigrationEvent =
  | { kind: 'force'; table: string; forced: boolean }
  | { kind: 'dml'; table: string; operation: 'DELETE' | 'INSERT' | 'UPDATE' }
  | { kind: 'dynamic'; operation: 'EXECUTE' }

const identifier = `(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)`
const qualifiedIdentifier = String.raw`${identifier}(?:\s*\.\s*${identifier})?`
const migrationEvent = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(${qualifiedIdentifier})\s+(NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY\b|\b(UPDATE)\s+(?:ONLY\s+)?(${qualifiedIdentifier})|\b(INSERT)\s+INTO\s+(${qualifiedIdentifier})|\b(DELETE)\s+FROM\s+(?:ONLY\s+)?(${qualifiedIdentifier})|\b(EXECUTE)\b`,
  'giu',
)

function tableName(source: string): string {
  const part = source.split('.').at(-1)?.trim() ?? source
  return part.startsWith('"')
    ? part.slice(1, -1).replaceAll('""', '"').toLowerCase()
    : part.toLowerCase()
}

function singleQuotedStringEnd(sql: string, start: number): number {
  let index = start + 1
  while (index < sql.length) {
    if (sql[index] !== "'") index++
    else if (sql[index + 1] === "'") index += 2
    else return index + 1
  }
  return sql.length
}

function dollarQuotedStringEnd(sql: string, start: number): number | null {
  const delimiter = sql.slice(start).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
  if (!delimiter) return null
  const close = sql.indexOf(delimiter, start + delimiter.length)
  return close < 0 ? sql.length : close + delimiter.length
}

function maskedSpanEnd(sql: string, start: number): number | null {
  if (sql.startsWith('--', start)) {
    const newline = sql.indexOf('\n', start)
    return newline < 0 ? sql.length : newline
  }
  if (sql.startsWith('/*', start)) {
    const close = sql.indexOf('*/', start + 2)
    return close < 0 ? sql.length : close + 2
  }
  return sql[start] === "'" ? singleQuotedStringEnd(sql, start) : null
}

function maskCommentsAndStrings(sql: string): string {
  let result = ''
  let doDelimiter: string | null = null
  for (let index = 0; index < sql.length; ) {
    if (doDelimiter && sql.startsWith(doDelimiter, index)) {
      result += ' '.repeat(doDelimiter.length)
      index += doDelimiter.length
      doDelimiter = null
      continue
    }
    if (sql[index] === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
      if (delimiter) {
        const statementPrefix = result.slice(result.lastIndexOf(';') + 1)
        if (!doDelimiter && /^\s*DO\b/i.test(statementPrefix)) {
          result += ' '.repeat(delimiter.length)
          index += delimiter.length
          doDelimiter = delimiter
          continue
        }
        const end = dollarQuotedStringEnd(sql, index) ?? sql.length
        result += ' '.repeat(end - index)
        index = end
        continue
      }
    }
    const end = maskedSpanEnd(sql, index)
    if (end === null) {
      result += sql[index]
      index++
    } else {
      result += ' '.repeat(end - index)
      index = end
    }
  }
  return result
}

function migrationEvents(sql: string): MigrationEvent[] {
  return [...maskCommentsAndStrings(sql).matchAll(migrationEvent)].map((match) => {
    if (match[1]) return { kind: 'force', table: tableName(match[1]), forced: !match[2] }
    if (match[3]) return { kind: 'dml', operation: 'UPDATE', table: tableName(match[4]) }
    if (match[5]) return { kind: 'dml', operation: 'INSERT', table: tableName(match[6]) }
    if (match[7]) return { kind: 'dml', operation: 'DELETE', table: tableName(match[8]) }
    return { kind: 'dynamic', operation: 'EXECUTE' }
  })
}

export function analyzeForcedRlsDml(
  sql: string,
  initiallyForcedTables: ReadonlySet<string>,
): ForcedRlsMigrationAnalysis {
  const initiallyForced = new Set([...initiallyForcedTables].map((table) => table.toLowerCase()))
  const forcedTables = new Set(initiallyForced)
  const knownForcedTables = new Set(initiallyForced)
  const findings: ForcedRlsDmlFinding[] = []
  const liftedDml = new Map<string, Set<'DELETE' | 'INSERT' | 'UPDATE'>>()
  const liftedDynamic = new Map<'EXECUTE', Set<string>>()

  for (const event of migrationEvents(sql)) {
    if (event.kind === 'force') {
      if (event.forced) {
        forcedTables.add(event.table)
        knownForcedTables.add(event.table)
      }
      else forcedTables.delete(event.table)
      continue
    }
    if (event.kind === 'dynamic') {
      if (forcedTables.size > 0) {
        findings.push({
          table: '*',
          operation: event.operation,
          reason: 'dynamic-sql-force-enabled',
        })
      } else if (knownForcedTables.size > 0) {
        liftedDynamic.set(event.operation, new Set(knownForcedTables))
      }
      continue
    }
    if (forcedTables.has(event.table)) {
      findings.push({ table: event.table, operation: event.operation, reason: 'force-enabled' })
    } else if (initiallyForced.has(event.table)) {
      const operations = liftedDml.get(event.table) ?? new Set()
      operations.add(event.operation)
      liftedDml.set(event.table, operations)
    }
  }

  for (const [table, operations] of liftedDml) {
    if (forcedTables.has(table)) continue
    for (const operation of operations) {
      findings.push({ table, operation, reason: 'force-not-restored' })
    }
  }
  for (const [operation, tables] of liftedDynamic) {
    if ([...tables].every((table) => forcedTables.has(table))) continue
    findings.push({ table: '*', operation, reason: 'dynamic-sql-force-not-restored' })
  }
  return { findings, forcedTables }
}
