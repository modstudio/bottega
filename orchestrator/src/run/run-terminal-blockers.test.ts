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
      name: 'a recognised declared blocker records the detector kind',
      facts: {
        declared: [
          {
            what: 'Docker access was denied',
            why: 'I could not run the suite.',
            impact: 'suite not run',
          },
        ],
        output: '',
      },
      expected: [
        {
          what: 'Docker access was denied',
          why: 'I could not run the suite.',
          impact: 'suite not run',
          source: 'declared',
          kind: 'docker-denied',
        },
      ],
    },
    {
      name: 'an unrecognised declared blocker records a null kind',
      facts: {
        declared: [{ what: 'tool missing', why: 'binary was unavailable', impact: null }],
        output: '',
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
      name: 'detectable output records a detected row when nothing was declared',
      facts: {
        declared: [],
        output: 'Docker access was denied, so I could not run the suite.',
      },
      expected: [
        {
          what: 'docker denied',
          why: 'Docker access was denied, so I could not run the suite.',
          impact: null,
          source: 'detected',
          kind: 'docker-denied',
        },
      ],
    },
    {
      name: 'a declared blocker suppresses detectable output',
      facts: {
        declared: [{ what: 'declared', why: 'worker report', impact: null }],
        output: 'Docker access was denied, so I could not run the suite.',
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
      facts: { declared: [], output: '' },
      expected: [],
    },
  ] satisfies Case[])('$name', ({ facts, expected }) => {
    expect(blockersToRecord(facts)).toEqual(expected)
  })
})
