import { describe, expect, test } from 'bun:test'
import { terminalLifecycleForWrite } from './run-terminal-lifecycle-verdict.ts'

const outcome = (
  status: string,
  failureKind: string | null = null,
  error: string | null = null,
) => ({
  status,
  failureKind,
  error,
})

describe('terminal lifecycle verdict', () => {
  test.each([
    [
      'stopped against asking',
      outcome('stopped', 'stopped', 'stopped by architect'),
      outcome('asking'),
    ],
    ['stopped against ok', outcome('stopped', 'stopped', 'stopped by architect'), outcome('ok')],
    [
      'abandoned against asking',
      outcome('stale', 'abandoned', 'abandoned by architect'),
      outcome('asking'),
    ],
    [
      'abandoned against ok',
      outcome('stale', 'abandoned', 'abandoned by architect'),
      outcome('ok'),
    ],
  ])('%s keeps the stored verdict', (_name, stored, incoming) => {
    expect(terminalLifecycleForWrite(stored, incoming)).toEqual(stored)
  })

  test.each([
    ['running', outcome('running'), outcome('ok', null, 'complete')],
    ['asking', outcome('asking'), outcome('ok', null, 'complete')],
  ])('%s takes the incoming outcome', (_name, stored, incoming) => {
    expect(terminalLifecycleForWrite(stored, incoming)).toEqual(incoming)
  })
})
