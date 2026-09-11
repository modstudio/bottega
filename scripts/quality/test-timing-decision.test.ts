import { describe, expect, test } from 'bun:test'
import { decideTestTiming } from './test-timing-decision'

describe('test timing decision', () => {
  test('records an initial measurement', () => {
    expect(decideTestTiming({ currentMs: 100, committedMs: undefined, growthLimit: 0.05 }))
      .toBe('initial')
  })

  test('passes growth within the allowance', () => {
    expect(decideTestTiming({ currentMs: 105, committedMs: 100, growthLimit: 0.05 }))
      .toBe('pass')
  })

  test('tightens a lower measurement', () => {
    expect(decideTestTiming({ currentMs: 99, committedMs: 100, growthLimit: 0.05 }))
      .toBe('tighten')
  })

  test('fails growth above the allowance', () => {
    expect(decideTestTiming({ currentMs: 106, committedMs: 100, growthLimit: 0.05 }))
      .toBe('fail')
  })
})
