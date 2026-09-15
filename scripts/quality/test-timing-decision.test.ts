import { describe, expect, test } from 'bun:test'
import { baselineDisposition, decideTestTiming } from './test-timing-decision'

describe('test timing decision', () => {
  test('records an initial measurement', () => {
    expect(decideTestTiming({ currentMs: 100, committedMs: undefined, growthLimit: 0.05 })).toBe(
      'initial',
    )
  })

  test('passes growth within the allowance', () => {
    expect(decideTestTiming({ currentMs: 105, committedMs: 100, growthLimit: 0.05 })).toBe('pass')
  })

  test('passes a drop within the allowance instead of rewriting the baseline', () => {
    expect(decideTestTiming({ currentMs: 96, committedMs: 100, growthLimit: 0.05 })).toBe('pass')
  })

  test('tightens a measurement below the allowance band', () => {
    expect(decideTestTiming({ currentMs: 94, committedMs: 100, growthLimit: 0.05 })).toBe('tighten')
  })

  test('fails growth above the allowance', () => {
    expect(decideTestTiming({ currentMs: 106, committedMs: 100, growthLimit: 0.05 })).toBe('fail')
  })
})

describe('baseline disposition', () => {
  test('a local run writes a moved baseline and a hosted run only reports it', () => {
    expect(baselineDisposition({ changed: true, ci: false })).toBe('write')
    expect(baselineDisposition({ changed: true, ci: true })).toBe('report')
    expect(baselineDisposition({ changed: false, ci: true })).toBe('keep')
    expect(baselineDisposition({ changed: false, ci: false })).toBe('keep')
  })
})
