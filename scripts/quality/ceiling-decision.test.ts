import { describe, expect, test } from 'bun:test'
import { decideCeiling } from './ceiling-decision'

describe('shrink-only ceiling decision', () => {
  test('passes a value under the ceiling', () => {
    expect(decideCeiling({ key: 'under.ts', value: 499, frozen: undefined, ceiling: 500 })).toBe(
      'pass',
    )
  })

  test('fails a value over the ceiling which is not frozen', () => {
    expect(decideCeiling({ key: 'new.ts', value: 501, frozen: undefined, ceiling: 500 })).toBe(
      'fail',
    )
  })

  test('lowers a frozen value which is shrinking', () => {
    expect(decideCeiling({ key: 'shrinking.ts', value: 550, frozen: 600, ceiling: 500 })).toBe(
      'lower',
    )
  })

  test('fails a frozen value which is growing', () => {
    expect(decideCeiling({ key: 'growing.ts', value: 601, frozen: 600, ceiling: 500 })).toBe('fail')
  })
})
