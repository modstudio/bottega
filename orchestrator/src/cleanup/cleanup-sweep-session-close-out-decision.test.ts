import { describe, expect, test } from 'bun:test'
import { decideSessionCloseOutSweep } from './cleanup-sweep-session-close-out-decision.ts'

describe('closed session sweep decision', () => {
  const clean = {
    clean: true,
    closedAt: 100,
    lastSeenAt: null,
    sweptAt: null,
  }

  test.each([
    ['newest clean row', clean, { action: 'sweep' }],
    ['unclean row', { ...clean, clean: false }, { action: 'skip', reason: 'unclean' }],
    ['seen after close-out', { ...clean, lastSeenAt: 101 }, { action: 'skip', reason: 'resumed' }],
    ['already swept', { ...clean, sweptAt: 102 }, { action: 'skip', reason: 'already-swept' }],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideSessionCloseOutSweep(facts)).toEqual(expected)
  })
})
