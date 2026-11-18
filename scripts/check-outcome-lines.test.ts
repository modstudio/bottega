import { expect, test } from 'bun:test'
import { outcomeLineViolations } from './check-outcome-lines.ts'

test('refuses a computed command exit followed by a bare id', () => {
  expect(
    outcomeLineViolations([
      {
        path: 'orchestrator/src/example.ts',
        source: `command.action(async () => {
  const result = await work()
  log(String(result.number))
  presentation.setExitCode(mapExitCode(result.exitCode))
})`,
      },
    ]),
  ).toEqual([
    'orchestrator/src/example.ts:3: bare id ends fallible command output; finish fallible command output with an outcome line that includes its id',
  ])
})

test('accepts an outcome line and ignores a success-only id', () => {
  expect(
    outcomeLineViolations([
      {
        path: 'orchestrator/src/example.ts',
        source: `command.action(async () => {
  const result = await work()
  log(formatOutcomeLine(result))
  presentation.setExitCode(result.exitCode)
})
export function create() {
  const result = save()
  print(record(result), String(result.id))
}`,
      },
    ]),
  ).toEqual([])
})
