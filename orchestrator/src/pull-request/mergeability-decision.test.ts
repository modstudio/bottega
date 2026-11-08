import { describe, expect, test } from 'bun:test'
import { decideMergeability } from './mergeability-decision.ts'

const input = (mergeStateStatus: string, boundReached = true) => ({
  mergeStateStatus,
  boundReached,
  url: 'https://github.example/pulls/42',
  landingBranch: 'main',
})

describe('pull-request mergeability', () => {
  test('reports a dirty head with the rebase remedy', () => {
    expect(decideMergeability(input('DIRTY'))).toEqual({
      kind: 'report',
      conflict: true,
      message:
        'https://github.example/pulls/42 conflicts with main: rebase it on the landing branch before merging',
    })
  })

  test.each(['CLEAN', 'BLOCKED'])('%s needs no report', (mergeStateStatus) => {
    expect(decideMergeability(input(mergeStateStatus))).toEqual({ kind: 'clear' })
  })

  test('polls an unknown state until the bound and then reports it', () => {
    expect(decideMergeability(input('UNKNOWN', false))).toEqual({ kind: 'poll' })
    expect(decideMergeability(input('UNKNOWN'))).toEqual({
      kind: 'report',
      conflict: false,
      message: 'mergeability not yet known for https://github.example/pulls/42',
    })
  })
})
