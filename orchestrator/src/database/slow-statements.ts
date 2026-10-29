// concern: database
/** Times statements on adapter-owned SQLite handles and records slow executions without changing their outcome. */
import type { Database } from 'bun:sqlite'
import { insertContention } from './contention.ts'

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
  writable: boolean
  thresholdMs?: number
  now?: () => number
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
    if (!options.writable || durationMs <= thresholdMs || recording) return
    recording = true
    try {
      insertContention(database, {
        resourceKind: 'store',
        resourceKey: statementFingerprint(sql),
        eventKind: 'wait',
        durationMs,
        cause: 'slow-statement',
      })
    } catch {
      /* Recording is evidence only and must never change statement behavior. */
    } finally {
      recording = false
    }
  }

  const timed = <T>(sql: string, action: () => T): T => {
    const started = now()
    try {
      return action()
    } finally {
      record(sql, now() - started)
    }
  }

  const statement = (sql: string, prepared: object): object =>
    new Proxy(prepared, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (property === 'iterate') {
          return (...args: unknown[]) => {
            const iterator = Reflect.apply(value, target, args) as Iterable<unknown>
            return (function* () {
              const started = now()
              try {
                yield* iterator
              } finally {
                record(sql, now() - started)
              }
            })()
          }
        }
        if (!['get', 'all', 'run', 'values'].includes(String(property))) return value.bind(target)
        return (...args: unknown[]) => timed(sql, () => Reflect.apply(value, target, args))
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
