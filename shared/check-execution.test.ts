import { expect, test } from 'bun:test'
import {
  parseCheckExecutionLines,
  UNCHECKED_EXIT_CODE,
  UNCHECKED_LINE_PREFIX,
  uncheckedReasonFromLines,
} from './check-execution.ts'

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

test('check execution lines retain unchecked reasons only with the unchecked exit code', () => {
  const unchecked = {
    check: 'audit',
    wallMs: 3,
    exitCode: UNCHECKED_EXIT_CODE,
    unchecked: 'audit host unavailable',
  }
  const invalid = { ...unchecked, exitCode: 0 }

  expect(
    parseCheckExecutionLines(`${JSON.stringify(unchecked)}\n${JSON.stringify(invalid)}\n`),
  ).toEqual({ records: [unchecked], rejected: 1 })
})

test('unchecked line writer and parser share the exact protocol', () => {
  const reason = 'audit host unavailable'
  expect(uncheckedReasonFromLines([`${UNCHECKED_LINE_PREFIX}${reason}`])).toBe(reason)
})
