import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { trackedCommentFindings } from './check-comment-extraction.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...argv: string[]): void {
  const result = spawnFixtureGitSync(argv, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

describe('tracked comment extraction', () => {
  test('skips an unstaged deletion and judges the remaining tracked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'comment-extraction-'))
    fixtureRoots.push(root)
    git(root, 'init', '-b', 'main')
    writeFileSync(join(root, 'deleted.ts'), '// DEV-1\n')
    writeFileSync(join(root, 'remaining.ts'), '// DEV-2\n')
    git(root, 'add', 'deleted.ts', 'remaining.ts')
    unlinkSync(join(root, 'deleted.ts'))

    const findings = trackedCommentFindings(root, { taskKeyPrefixes: ['DEV'] })

    expect(findings.map(({ file, match }) => ({ file, match }))).toEqual([
      { file: 'remaining.ts', match: 'DEV-2' },
    ])
  })
})
