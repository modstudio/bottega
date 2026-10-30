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

  test('timeout retries stop at the consecutive timeout ceiling', () => {
    expect(retryDecision('55P03', MAX_CONSECUTIVE_TIMEOUTS - 1)).toBe('retry')
    expect(retryDecision('57014', MAX_CONSECUTIVE_TIMEOUTS)).toBe('stop')
    expect(retryDecision('23514', MAX_CONSECUTIVE_TIMEOUTS)).toBe('rethrow')
  })
})
