import { afterEach, beforeEach, expect, test } from 'bun:test'
import { recordArchitectRead } from './review-read.ts'

let priorDepth: string | undefined
beforeEach(() => {
  priorDepth = process.env.ORCH_DEPTH
  process.env.ORCH_DEPTH = '1'
})
afterEach(() => {
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
})

test('worker sessions cannot record an architect read', () => {
  expect(() => recordArchitectRead({ cwd: '/unused', note: 'read the final fix' })).toThrow(
    'reserved for architect sessions',
  )
})
