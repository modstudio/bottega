import { expect, spyOn, test } from 'bun:test'
import { run } from '../cli/program.ts'

test('agent context set enforces matching record shapes before resolving a holder', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
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
      expect(
        await run([
          'context',
          'set',
          '--session',
          'missing-holder',
          '--kind',
          kind,
          '--source',
          'test',
          '--id',
          'shape',
          body,
        ]),
      ).toBe(1)
      expect(errors.at(-1)).toContain(refusal)
    }
  } finally {
    error.mockRestore()
  }
})
