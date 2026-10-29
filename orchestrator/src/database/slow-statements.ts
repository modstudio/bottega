// concern: database
/** Times statements on adapter-owned SQLite handles and records slow executions without changing their outcome. */
import type { Database } from 'bun:sqlite'

const SLOW_STATEMENT_MS = 100
const STATEMENT_FINGERPRINT_LENGTH = 240

const STRING_LITERAL = /'(?:''|[^'])*'/g
const BLOB_LITERAL = /\b[xX]'[0-9a-fA-F]*'/g
const NUMERIC_LITERAL = /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi

export function statementFingerprint(sql: string): string {
  return sql
    .replace(BLOB_LITERAL, '?')
    .replace(STRING_LITERAL, '?')
    .replace(NUMERIC_LITERAL, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATEMENT_FINGERPRINT_LENGTH)
}

export type StatementTimingOptions = {
  recorder: (fingerprint: string, durationMs: number) => void
  thresholdMs?: number
  now?: () => number
}

export type StatementExecutionCallback = (sql: string, args: unknown[], elapsedMs: number) => void

/**
 * Interpose every bun:sqlite statement execution while preserving the Database and Statement
 * shapes. Iterator timing ends when iteration ends, not when the iterator is constructed.
 */
export function interposeStatementExecutions(
  database: Database,
  onExecution: StatementExecutionCallback,
  now: () => number = performance.now.bind(performance),
): Database {
  const finished = (sql: string, args: unknown[], started: number): void => {
    try {
      onExecution(sql, args, now() - started)
    } catch {
      /* Observing a statement must never change its behavior. */
    }
  }

  const statement = (sql: string, prepared: object): object =>
    new Proxy(prepared, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (property === 'iterate') {
          return (...args: unknown[]) => {
            const started = now()
            const iterator = Reflect.apply(value, target, args) as Iterable<unknown>
            return (function* () {
              try {
                yield* iterator
              } finally {
                finished(sql, args, started)
              }
            })()
          }
        }
        if (!['get', 'all', 'run', 'values'].includes(String(property))) return value.bind(target)
        return (...args: unknown[]) => {
          const started = now()
          try {
            return Reflect.apply(value, target, args)
          } finally {
            finished(sql, args, started)
          }
        }
      },
    })

  const query = database.query.bind(database)
  const prepare = database.prepare.bind(database)
  Object.defineProperty(database, 'query', {
    configurable: true,
    value: (sql: string) => statement(sql, query(sql)),
  })
  Object.defineProperty(database, 'prepare', {
    configurable: true,
    value: (sql: string) => statement(sql, prepare(sql)),
  })
  return database
}

const instrumented = new WeakSet<Database>()

/**
 * Keep the public bun:sqlite shape: callers still receive a Database and its native statements.
 * Only the statement execution methods are interposed; every other property is read from the
 * native receiver so transaction helpers and connection state retain their Bun semantics.
 */
export function instrumentDatabase(database: Database, options: StatementTimingOptions): Database {
  if (instrumented.has(database)) return database
  instrumented.add(database)
  const thresholdMs = options.thresholdMs ?? SLOW_STATEMENT_MS
  const now = options.now ?? performance.now.bind(performance)
  let recording = false

  const record = (sql: string, durationMs: number): void => {
    if (durationMs <= thresholdMs || recording) return
    recording = true
    try {
      options.recorder(statementFingerprint(sql), durationMs)
    } catch {
      /* Recording is evidence only and must never change statement behavior. */
    } finally {
      recording = false
    }
  }

  return interposeStatementExecutions(
    database,
    (sql, _args, elapsedMs) => {
      record(sql, elapsedMs)
    },
    now,
  )
}
