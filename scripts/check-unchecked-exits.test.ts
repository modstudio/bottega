import { expect, test } from 'bun:test'
import { uncheckedExitViolations } from './check-unchecked-exits.ts'

test('flags a static-check fixture that exits successfully without reporting unchecked', () => {
  expect(
    uncheckedExitViolations([
      { path: 'scripts/fixture.ts', source: "console.log('skipped')\nprocess.exit(0)\n" },
    ]),
  ).toEqual(['scripts/fixture.ts:2: replace an explicit successful exit with exitUnchecked'])
})
