import { describe, expect, test } from 'bun:test'
import { mergeTimings } from './record-gate-timings.ts'

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

    const result = mergeTimings({}, xml, {
      stamp: 'stamp', command: ['bun', 'test'], elapsedMs: 18, exitCode: 1,
    })

    expect(result.tests.map(({ name, file, pass }) => ({ name, file, pass }))).toEqual([
      { name: 'passing row', file: 'src/example.test.ts', pass: true },
      { name: 'console-printing row', file: 'src/example.test.ts', pass: true },
      { name: 'failing row', file: 'src/example.test.ts', pass: false },
    ])
    expect(result.tests.map(({ wallMs }) => wallMs)).toEqual([
      expect.closeTo(0.043), expect.closeTo(0.03), expect.closeTo(0.109),
    ])
    expect(result.files).toMatchObject([
      { file: 'src/example.test.ts', wallMs: 17, tests: 3, failed: 1 },
    ])
  })
})
