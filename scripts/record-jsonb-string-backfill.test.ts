import { describe, expect, test } from 'bun:test'
import {
  BACKFILL_COLUMNS,
  buildColumnSql,
  buildSelectionPredicate,
  MAX_CONSECUTIVE_TIMEOUTS,
  retryDecision,
} from './record-jsonb-string-backfill.ts'

describe('record jsonb string backfill policy', () => {
  test('the dry-run and update SQL use the same selection predicate', () => {
    for (const target of BACKFILL_COLUMNS) {
      const predicate = buildSelectionPredicate(target)
      const queries = buildColumnSql(target)
      expect(queries.count).toContain(predicate)
      expect(queries.update).toContain(predicate)
    }
  })

  test('landing override missing lenses selects only parsed arrays', () => {
    const target = BACKFILL_COLUMNS.find(
      (candidate) =>
        candidate.table === 'landing_override' && candidate.column === 'missing_lenses',
    )
    expect(target).toBeDefined()
    expect(buildSelectionPredicate(target!)).toContain(
      `jsonb_typeof(("missing_lenses" #>> '{}')::jsonb) = 'array'`,
    )
  })

  test('lists all columns from the removed repair migration', () => {
    expect(BACKFILL_COLUMNS).toHaveLength(38)
    expect(new Set(BACKFILL_COLUMNS.map(({ table }) => table))).toHaveLength(14)
    expect(new Set(BACKFILL_COLUMNS.map(({ table, column }) => `${table}.${column}`))).toHaveLength(
      38,
    )
  })

  test('timeout retries stop at the consecutive timeout ceiling', () => {
    expect(retryDecision('55P03', MAX_CONSECUTIVE_TIMEOUTS - 1)).toBe('retry')
    expect(retryDecision('57014', MAX_CONSECUTIVE_TIMEOUTS)).toBe('stop')
    expect(retryDecision('23514', MAX_CONSECUTIVE_TIMEOUTS)).toBe('rethrow')
  })
})
