import { describe, expect, test } from 'bun:test'
import { mergeTimings } from './record-gate-timings.ts'

const meta = {
  stamp: 'stamp',
  command: ['bun', 'test'],
  elapsedMs: 18,
  exitCode: 0,
}

describe('mergeTimings', () => {
  test('keeps every Bun junit row when self-closing cases precede a failure', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="3" failures="1" skipped="0" time="0.017651">
  <testsuite name="src/example.test.ts" file="src/example.test.ts" tests="3" assertions="3" failures="1" skipped="0" time="0.017" hostname="host">
    <testcase name="passing row" classname="" time="0.000043" file="src/example.test.ts" line="3" assertions="1" />
    <testcase name="console-printing row" classname="" time="0.00003" file="src/example.test.ts" line="7" assertions="1" />
    <testcase name="failing row" classname="" time="0.000109" file="src/example.test.ts" line="12" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>`

    const result = mergeTimings({}, xml, { ...meta, exitCode: 1 })

    expect(result.tests.map(({ name, file, pass }) => ({ name, file, pass }))).toEqual([
      { name: 'passing row', file: 'src/example.test.ts', pass: true },
      { name: 'console-printing row', file: 'src/example.test.ts', pass: true },
      { name: 'failing row', file: 'src/example.test.ts', pass: false },
    ])
    expect(result.tests.map(({ wallMs }) => wallMs)).toEqual([
      expect.closeTo(0.043),
      expect.closeTo(0.03),
      expect.closeTo(0.109),
    ])
    expect(result.files).toMatchObject([
      { file: 'src/example.test.ts', wallMs: 17, tests: 3, failed: 1 },
    ])
  })

  test('attaches phases within each file without consuming a skipped row', () => {
    const xml = `<testsuites>
  <testsuite file="src/alpha.test.ts" tests="3" failures="0" time="0.003">
    <testcase name="alpha one" file="src/alpha.test.ts" time="0.001" />
    <testcase name="alpha skipped" file="src/alpha.test.ts" time="0"><skipped /></testcase>
    <testcase name="alpha two" file="src/alpha.test.ts" time="0.002" />
  </testsuite>
  <testsuite file="src/beta.test.ts" tests="1" failures="0" time="0.004">
    <testcase name="beta one" file="src/beta.test.ts" time="0.004" />
  </testsuite>
</testsuites>`

    const result = mergeTimings(
      {
        testPhases: [
          { file: 'src/alpha.test.ts', setupMs: 11, teardownMs: 12 },
          { file: 'src/alpha.test.ts', setupMs: 21, teardownMs: 22 },
          { file: 'src/beta.test.ts', setupMs: 31, teardownMs: 32 },
        ],
      },
      xml,
      meta,
    )

    expect(
      result.tests.map(({ name, setupMs, teardownMs }) => ({ name, setupMs, teardownMs })),
    ).toEqual([
      { name: 'alpha one', setupMs: 11, teardownMs: 12 },
      { name: 'alpha skipped', setupMs: undefined, teardownMs: undefined },
      { name: 'alpha two', setupMs: 21, teardownMs: 22 },
      { name: 'beta one', setupMs: 31, teardownMs: 32 },
    ])
    expect(result.phaseTimingNotices).toEqual([])
  })

  test('contains a beforeAll failure mismatch within its file', () => {
    const xml = `<testsuites>
  <testsuite file="src/broken.test.ts" tests="1" failures="1" time="0.005">
    <testcase name="(unnamed)" file="src/broken.test.ts" time="0.005">
      <failure type="Error" message="beforeAll boom" />
    </testcase>
  </testsuite>
  <testsuite file="src/healthy.test.ts" tests="1" failures="0" time="0.001">
    <testcase name="healthy" file="src/healthy.test.ts" time="0.001" />
  </testsuite>
</testsuites>`

    const result = mergeTimings(
      {
        testPhases: [{ file: 'src/healthy.test.ts', setupMs: 41, teardownMs: 42 }],
      },
      xml,
      { ...meta, exitCode: 1 },
    )

    expect(result.tests[0]).not.toHaveProperty('setupMs')
    expect(result.tests[1]).toMatchObject({
      file: 'src/healthy.test.ts',
      name: 'healthy',
      setupMs: 41,
      teardownMs: 42,
    })
    expect(result.phaseTimingNotices).toEqual([
      'phase timings not attributed for src/broken.test.ts: 1 rows, 0 samples',
    ])
  })

  test('attributes no phases for a file whose row and sample counts differ', () => {
    const xml = `<testsuites>
  <testsuite file="src/mismatch.test.ts" tests="2" failures="0" time="0.002">
    <testcase name="first" file="src/mismatch.test.ts" time="0.001" />
    <testcase name="second" file="src/mismatch.test.ts" time="0.001" />
  </testsuite>
</testsuites>`

    const result = mergeTimings(
      {
        testPhases: [{ file: 'src/mismatch.test.ts', setupMs: 51, teardownMs: 52 }],
      },
      xml,
      meta,
    )

    expect(result.tests.every((row) => row.setupMs === undefined)).toBeTrue()
    expect(result.phaseTimingNotices).toEqual([
      'phase timings not attributed for src/mismatch.test.ts: 2 rows, 1 samples',
    ])
  })
})
