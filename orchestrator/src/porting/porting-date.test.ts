import { expect, test } from 'bun:test'
import { normalizePortBaselineScannedAt } from './porting-date.ts'

test('date-only baseline timestamps become midnight UTC and all other values pass through', () => {
  expect(normalizePortBaselineScannedAt('2026-08-24')).toBe('2026-08-24T00:00:00.000Z')
  expect(normalizePortBaselineScannedAt('2026-08-24T10:11:12.000-04:00')).toBe(
    '2026-08-24T10:11:12.000-04:00',
  )
  expect(normalizePortBaselineScannedAt(null)).toBeNull()
})
