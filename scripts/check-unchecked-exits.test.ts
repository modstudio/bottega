import { expect, test } from 'bun:test'
import { uncheckedExitViolations } from './check-unchecked-exits.ts'

test('flags a static-check fixture that exits successfully without reporting unchecked', () => {
  expect(
    uncheckedExitViolations([
      {
        path: 'scripts/fixture.ts',
        source:
          "console.log('skipped')\nprocess.exit(0)\nif (done) process.exit()\nprocess.exit(1)\n",
      },
    ]),
  ).toEqual([
    'scripts/fixture.ts:2: an explicit zero exit is refused in a gate check; let success fall through, or call exitUnchecked when the check could not run',
    'scripts/fixture.ts:3: an explicit zero exit is refused in a gate check; let success fall through, or call exitUnchecked when the check could not run',
  ])
})
