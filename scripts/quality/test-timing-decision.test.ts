import { describe, expect, test } from 'bun:test'
import {
  baselineDisposition,
  decideTestTiming,
  decideTestTimingRun,
  longPoleFailures,
  SINGLE_TEST_WALL_CEILING_MS,
  TEST_FILE_WALL_CEILING_MS,
} from './test-timing-decision'

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

test('long-pole ceilings name only test files and tests over their absolute limit', () => {
  expect(
    longPoleFailures(
      [
        { file: 'src/fast.test.ts', wallMs: TEST_FILE_WALL_CEILING_MS },
        { file: 'src/slow.test.ts', wallMs: TEST_FILE_WALL_CEILING_MS + 1 },
        { file: '(process)', wallMs: TEST_FILE_WALL_CEILING_MS + 1 },
      ],
      [
        { file: 'src/fast.test.ts', name: 'at limit', wallMs: SINGLE_TEST_WALL_CEILING_MS },
        { file: 'src/slow.test.ts', name: 'over limit', wallMs: SINGLE_TEST_WALL_CEILING_MS + 1 },
      ],
    ),
  ).toEqual([
    'src/slow.test.ts 3001ms exceeds test file ceiling 3000ms',
    'src/slow.test.ts: over limit 1001ms exceeds single test ceiling 1000ms',
  ])
})

test('a shard skips growth but still enforces ceilings; a whole-suite run compares growth', () => {
  const files = [{ file: 'src/slow.test.ts', wallMs: TEST_FILE_WALL_CEILING_MS + 1 }]
  const tests = [
    { file: 'src/slow.test.ts', name: 'slow branch', wallMs: SINGLE_TEST_WALL_CEILING_MS + 1 },
  ]
  expect(decideTestTimingRun({ sharded: true, files, tests })).toEqual({
    growth: 'skip-sharded',
    longPoles: [
      'src/slow.test.ts 3001ms exceeds test file ceiling 3000ms',
      'src/slow.test.ts: slow branch 1001ms exceeds single test ceiling 1000ms',
    ],
  })
  expect(decideTestTimingRun({ sharded: false, files: [], tests: [] })).toEqual({
    growth: 'compare',
    longPoles: [],
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
