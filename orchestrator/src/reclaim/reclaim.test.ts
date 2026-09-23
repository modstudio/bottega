import { describe, expect, test } from 'bun:test'
import { decideBranchReclaimEvidence } from './reclaim.ts'

describe('branch reclaim landing evidence', () => {
  test('refuses unreachable commits without a safe prune classification', () => {
    expect(
      decideBranchReclaimEvidence({
        absentCommits: ['abc123'],
        classification: 'unlanded',
      }),
    ).toEqual({ allowed: false, state: 'unlanded' })
    expect(
      decideBranchReclaimEvidence({
        absentCommits: ['abc123'],
        classification: 'unknown',
      }),
    ).toEqual({ allowed: false, state: 'unknown' })
  })

  test('allows reachable commits and the prune classifier safe states', () => {
    expect(
      decideBranchReclaimEvidence({
        absentCommits: [],
        classification: 'unlanded',
      }),
    ).toEqual({
      allowed: true,
      proof: 'reachable',
    })
    for (const classification of ['landed', 'superseded', 'empty'] as const) {
      expect(
        decideBranchReclaimEvidence({
          absentCommits: ['abc123'],
          classification,
        }),
      ).toEqual({
        allowed: true,
        proof: classification,
      })
    }
  })
})
