import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { noRepoIsolatePath } from './run-artifacts.ts'

describe('review-lens-inline has no checkout', () => {
  test('the no-repo isolate is deterministically named below an owned runs directory', () => {
    const ownedRuns = '/var/lib/orch/runs'
    expect(noRepoIsolatePath(42, ownedRuns)).toBe('/var/lib/orch/runs/isolates/42')
    expect(noRepoIsolatePath(42, ownedRuns).startsWith(tmpdir())).toBe(false)
  })
})
