import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { closeOutRun } from './close-out.ts'
import { cleanFixture, closeOutFixture } from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('close-out refuses before removing its current working directory', () => {
  const originalCwd = process.cwd()
  const fixture = closeOutFixture()
  try {
    process.chdir(fixture.worktree)
    const result = closeOutRun(fixture.id, { intent: 'explicit' })

    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain(`current working directory ${fixture.worktree} is inside it`)
    expect(result.detail).toContain(`run this command from the main checkout ${fixture.repo}`)
    expect(existsSync(fixture.worktree)).toBe(true)
  } finally {
    process.chdir(originalCwd)
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
