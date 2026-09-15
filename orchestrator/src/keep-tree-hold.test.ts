import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_KEEP_TREE_HOURS,
  keepTreeExemption,
  keepTreeHold,
  MAX_KEEP_TREE_HOURS,
  parseKeepTreeDuration,
} from './keep-tree-hold.ts'

describe('keepTreeHold', () => {
  const base = {
    keepTree: true,
    keepTreeUntil: '2026-09-16T12:00:00.000Z',
    startedAt: '2026-09-15T12:00:00.000Z',
  }

  test('holds until a future explicit expiry', () => {
    expect(keepTreeHold({ ...base, now: '2026-09-16T11:59:59.999Z' })).toEqual({
      held: true,
      until: '2026-09-16T12:00:00.000Z',
    })
  })

  test('reports an explicit hold expired at its boundary', () => {
    expect(keepTreeHold({ ...base, now: '2026-09-16T12:00:00.000Z' })).toEqual({
      held: false,
      expiredAt: '2026-09-16T12:00:00.000Z',
    })
  })

  test('derives a legacy expiry 24 hours after the run started', () => {
    expect(
      keepTreeHold({
        ...base,
        keepTreeUntil: null,
        now: '2026-09-16T11:59:59.999Z',
      }),
    ).toEqual({ held: true, until: '2026-09-16T12:00:00.000Z' })
  })

  test('does not hold without the durable flag', () => {
    expect(keepTreeHold({ ...base, keepTree: false, now: '2026-09-15T12:00:00.000Z' })).toEqual({
      held: false,
    })
  })
})

describe('parseKeepTreeDuration', () => {
  test('defaults a bare flag to 24 hours', () => {
    expect(parseKeepTreeDuration(undefined)).toBe(DEFAULT_KEEP_TREE_HOURS)
    expect(keepTreeExemption(parseKeepTreeDuration(undefined), undefined, 0)).toEqual({
      until: '1970-01-02T00:00:00.000Z',
      reason: 'explicit --keep-tree',
    })
  })

  test('accepts an explicit positive duration through the maximum', () => {
    expect(parseKeepTreeDuration('1.5')).toBe(1.5)
    expect(parseKeepTreeDuration(String(MAX_KEEP_TREE_HOURS))).toBe(MAX_KEEP_TREE_HOURS)
    expect(keepTreeExemption(parseKeepTreeDuration('1.5'), 'inspection', 0)).toEqual({
      until: '1970-01-01T01:30:00.000Z',
      reason: 'inspection',
    })
  })

  test('refuses a duration above 72 hours and names the limit', () => {
    expect(() => parseKeepTreeDuration('72.1')).toThrow('maximum 72')
  })

  test.each(['0', '-1', 'soon', 'Infinity'])('refuses invalid duration %s', (raw) => {
    expect(() => parseKeepTreeDuration(raw)).toThrow(
      '--keep-tree duration must be a positive number of hours, maximum 72',
    )
  })
})
