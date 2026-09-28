import { expect, test } from 'bun:test'
import { recordArchitectRead } from './review-read.ts'

test('worker sessions cannot record an architect read', () => {
  const prior = process.env.ORCH_DEPTH
  process.env.ORCH_DEPTH = '1'
  try {
    expect(() => recordArchitectRead({ cwd: '/unused', note: 'read the final fix' })).toThrow(
      'reserved for architect sessions',
    )
  } finally {
    if (prior === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = prior
  }
})
