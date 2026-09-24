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
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(${qualifiedIdentifier})\s+(NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY\b|\b(UPDATE)\s+(?:ONLY\s+)?(${qualifiedIdentifier})|\b(INSERT)\s+INTO\s+(${qualifiedIdentifier})|\b(DELETE)\s+FROM\s+(?:ONLY\s+)?(${qualifiedIdentifier})|(?:^|;|\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b)\s*(EXECUTE)\b`,
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

type DollarQuoteStep = { end: number; nextDoDelimiter: string | null }

function dollarQuoteStep(
  sql: string,
  start: number,
  maskedPrefix: string,
  doDelimiter: string | null,
): DollarQuoteStep | null {
  if (sql[start] !== '$') return null
  const delimiter = sql.slice(start).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
  if (!delimiter) return null
  if (doDelimiter === delimiter) {
    return { end: start + delimiter.length, nextDoDelimiter: null }
  }
  const statementPrefix = maskedPrefix.slice(maskedPrefix.lastIndexOf(';') + 1)
  if (!doDelimiter && /^\s*DO\b/i.test(statementPrefix)) {
    return {
      end: start + delimiter.length,
      nextDoDelimiter: delimiter,
    }
  }
  return {
    end: dollarQuotedStringEnd(sql, start) ?? sql.length,
    nextDoDelimiter: doDelimiter,
  }
}

function maskCommentsAndStrings(sql: string): string {
  let result = ''
  let doDelimiter: string | null = null
  for (let index = 0; index < sql.length; ) {
    const dollarQuote = dollarQuoteStep(sql, index, result, doDelimiter)
    if (dollarQuote) {
      result += ' '.repeat(dollarQuote.end - index)
      index = dollarQuote.end
      doDelimiter = dollarQuote.nextDoDelimiter
      continue
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

type AnalysisState = {
  initiallyForced: Set<string>
  forcedTables: Set<string>
  knownForcedTables: Set<string>
  findings: ForcedRlsDmlFinding[]
  liftedDml: Map<string, Set<'DELETE' | 'INSERT' | 'UPDATE'>>
  liftedDynamic: Map<'EXECUTE', Set<string>>
}

function applyMigrationEvent(event: MigrationEvent, state: AnalysisState): void {
  if (event.kind === 'force') {
    if (event.forced) {
      state.forcedTables.add(event.table)
      state.knownForcedTables.add(event.table)
    } else state.forcedTables.delete(event.table)
    return
  }
  if (event.kind === 'dynamic') {
    if (state.forcedTables.size > 0) {
      state.findings.push({
        table: '*',
        operation: event.operation,
        reason: 'dynamic-sql-force-enabled',
      })
    } else if (state.knownForcedTables.size > 0) {
      state.liftedDynamic.set(event.operation, new Set(state.knownForcedTables))
    }
    return
  }
  if (state.forcedTables.has(event.table)) {
    state.findings.push({
      table: event.table,
      operation: event.operation,
      reason: 'force-enabled',
    })
    return
  }
  if (!state.initiallyForced.has(event.table)) return
  const operations = state.liftedDml.get(event.table) ?? new Set()
  operations.add(event.operation)
  state.liftedDml.set(event.table, operations)
}

function appendRestorationFindings(state: AnalysisState): void {
  for (const [table, operations] of state.liftedDml) {
    if (state.forcedTables.has(table)) continue
    for (const operation of operations) {
      state.findings.push({ table, operation, reason: 'force-not-restored' })
    }
  }
  for (const [operation, tables] of state.liftedDynamic) {
    if ([...tables].every((table) => state.forcedTables.has(table))) continue
    state.findings.push({ table: '*', operation, reason: 'dynamic-sql-force-not-restored' })
  }
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
  const state: AnalysisState = {
    initiallyForced,
    forcedTables: new Set(initiallyForced),
    knownForcedTables: new Set(initiallyForced),
    findings: [],
    liftedDml: new Map(),
    liftedDynamic: new Map(),
  }
  for (const event of migrationEvents(sql)) applyMigrationEvent(event, state)
  appendRestorationFindings(state)
  return { findings: state.findings, forcedTables: state.forcedTables }
}
