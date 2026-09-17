import { describe, expect, test } from 'bun:test'
import { decideTreeRefresh } from './tree-refresh.ts'

describe('tree refresh decision', () => {
  test('a clean current tree stays current', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 0, behindCommits: 0 })).toEqual({
      action: 'current',
    })
  })

  test('a clean behind tree without own commits fast-forwards', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 0, behindCommits: 3 })).toEqual({
      action: 'fast-forward',
    })
  })

  test('a clean behind tree with own commits refuses', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 2, behindCommits: 3 })).toEqual({
      action: 'refuse',
      reason: 'diverged',
    })
  })

  test('a dirty tree refuses', () => {
    expect(decideTreeRefresh({ clean: false, ownCommits: 0, behindCommits: 0 })).toEqual({
      action: 'refuse',
      reason: 'dirty',
    })
  })
})
