import { describe, expect, test } from 'bun:test'
import { decideHostedRevisionRead, docDiffPair } from './doc-history-source.ts'

describe('document history source', () => {
  test.each([
    ['revisions', 'print-hosted'],
    ['not-found', 'not-found'],
    ['failed', 'refuse'],
  ] as const)('maps hosted %s to %s', (outcome, decision) => {
    expect(decideHostedRevisionRead(outcome)).toBe(decision)
  })

  test('selects an explicit or default diff pair and refuses a short history', () => {
    expect(docDiffPair(['newest', 'previous'], 'first', 'second')).toEqual(['first', 'second'])
    expect(docDiffPair(['newest', 'previous'], undefined, undefined)).toEqual([
      'previous',
      'newest',
    ])
    expect(() => docDiffPair(['only'], undefined, undefined)).toThrow(
      'doc diff needs two revisions; this address has fewer than two',
    )
  })
})
