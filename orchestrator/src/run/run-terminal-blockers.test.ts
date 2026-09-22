import { describe, expect, test } from 'bun:test'
import { type BlockerFacts, type BlockerRow, blockersToRecord } from './run-terminal-blockers.ts'

type Case = {
  name: string
  facts: BlockerFacts
  expected: BlockerRow[]
}

describe('terminal blocker rows', () => {
  test.each([
    {
      name: 'declared blockers keep their order and detector kinds',
      facts: {
        declared: [
          { what: 'first', why: 'denied socket', impact: 'suite not run', kind: 'denied' },
          { what: 'second', why: 'unknown failure', impact: null, kind: null },
        ],
        detected: [],
      },
      expected: [
        {
          what: 'first',
          why: 'denied socket',
          impact: 'suite not run',
          source: 'declared',
          kind: 'denied',
        },
        {
          what: 'second',
          why: 'unknown failure',
          impact: null,
          source: 'declared',
          kind: null,
        },
      ],
    },
    {
      name: 'a declared blocker without impact records null',
      facts: {
        declared: [{ what: 'tool missing', why: 'binary was unavailable', kind: null }],
        detected: [],
      },
      expected: [
        {
          what: 'tool missing',
          why: 'binary was unavailable',
          impact: null,
          source: 'declared',
          kind: null,
        },
      ],
    },
    {
      name: 'detected rows appear when nothing was declared',
      facts: {
        declared: [],
        detected: [{ what: 'Docker denied', why: 'socket access failed', kind: 'denied' }],
      },
      expected: [
        {
          what: 'Docker denied',
          why: 'socket access failed',
          impact: null,
          source: 'detected',
          kind: 'denied',
        },
      ],
    },
    {
      name: 'a declared list suppresses detected blockers',
      facts: {
        declared: [{ what: 'declared', why: 'worker report', impact: null, kind: null }],
        detected: [{ what: 'detected', why: 'output match', kind: 'quota' }],
      },
      expected: [
        {
          what: 'declared',
          why: 'worker report',
          impact: null,
          source: 'declared',
          kind: null,
        },
      ],
    },
    {
      name: 'empty facts produce no rows',
      facts: { declared: [], detected: [] },
      expected: [],
    },
  ] satisfies Case[])('$name', ({ facts, expected }) => {
    expect(blockersToRecord(facts)).toEqual(expected)
  })
})
