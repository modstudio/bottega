import { expect, test } from 'bun:test'
import { parseCheckExecutionLines } from './check-execution.ts'

test('check execution lines retain valid records around malformed and wrong-shaped lines', () => {
  const first = { check: 'lint', wallMs: 12.5, cpuMs: 8, exitCode: 0 }
  const second = {
    check: 'file ceiling',
    category: 'file-length',
    wallMs: 20,
    exitCode: 1,
    remaining: 3,
  }
  expect(
    parseCheckExecutionLines(
      `${JSON.stringify(first)}\nnot json\n${JSON.stringify({ ...first, extra: true })}\n${JSON.stringify(second)}\n`,
    ),
  ).toEqual({ records: [first, second], rejected: 2 })
})
