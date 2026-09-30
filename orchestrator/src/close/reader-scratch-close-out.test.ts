import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { closeOutRun } from './close-out.ts'
import { cleanFixture, closeOutFixture } from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('reader close-out releases a clean clone without nested repositories', () => {
  const fixture = closeOutFixture()
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'released' })
    expect(existsSync(fixture.worktree)).toBe(false)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
