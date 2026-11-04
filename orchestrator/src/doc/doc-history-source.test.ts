import { describe, expect, test } from 'bun:test'
import { decideDocHistorySource, decideHostedRevisionRead } from './doc-history-source.ts'

describe('document history source', () => {
  for (const hostedConfigured of [false, true])
    for (const signedIn of [false, true])
      test(`configured=${hostedConfigured} signed-in=${signedIn}`, () => {
        expect(decideDocHistorySource({ hostedConfigured, signedIn })).toBe(
          hostedConfigured && signedIn ? 'hosted' : 'local',
        )
      })

  test.each([
    ['revisions', 'print-hosted'],
    ['not-found', 'read-local'],
    ['failed', 'refuse'],
  ] as const)('maps hosted %s to %s', (outcome, decision) => {
    expect(decideHostedRevisionRead(outcome)).toBe(decision)
  })
})
