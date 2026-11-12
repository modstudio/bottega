import { expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { run } from '../cli/program.ts'
import { getDoc } from '../doc/docs.ts'
import { contextClearReport } from './context.ts'

test('agent context set refuses matching record shapes without writing', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  const session = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    const cases = [
      {
        kind: 'ruling',
        body: 'x'.repeat(1501),
        refusal: 'ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)',
      },
      {
        kind: 'open-question',
        body: 'first\n\nsecond',
        refusal: 'open question must be one paragraph with no blank line',
      },
      {
        kind: 'next-action',
        body: 'first\nsecond',
        refusal: 'next action must be one line',
      },
    ]
    for (const { kind, body, refusal } of cases) {
      const source = kind === 'ruling' ? 'q1' : 'test'
      expect(
        await run([
          'context',
          'set',
          '--session',
          session,
          '--kind',
          kind,
          '--source',
          source,
          '--id',
          'shape',
          body,
        ]),
      ).toBe(1)
      expect(errors.at(-1)).toContain(refusal)
      expect(getDoc('context', `session:${session}`, 'shape')).toBeNull()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
    error.mockRestore()
  }
})

test('context clear reports an empty holder as a successful zero-item clear', () => {
  expect(contextClearReport({ task: 'DEV-2270', removed: 0 })).toBe(
    'context: cleared 0 items on DEV-2270',
  )
})
