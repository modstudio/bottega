import { describe, expect, test } from 'bun:test'
import { decideSessionCloseOutSweep } from './cleanup-sweep-session-close-out-decision.ts'

describe('closed session sweep decision', () => {
  const clean = {
    newest: true,
    clean: true,
    closedAt: 100,
    lastSeenAt: null,
    sweptAt: null,
  }

  test.each([
    ['newest clean row', clean, { action: 'sweep' }],
    ['later unclean row', { ...clean, newest: false }, { action: 'skip', reason: 'superseded' }],
    ['seen after close-out', { ...clean, lastSeenAt: 101 }, { action: 'skip', reason: 'resumed' }],
    ['already swept', { ...clean, sweptAt: 102 }, { action: 'skip', reason: 'already-swept' }],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideSessionCloseOutSweep(facts)).toEqual(expected)
  })
})
