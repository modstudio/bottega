import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertProject } from '../project/projects.ts'
import { readOnlyRemovalRefusal, removeFor } from './worktree-remove.ts'

const directories: string[] = []
const originalPath = process.env.PATH

function fakeGit(): { log: string } {
  const root = mkdtempSync(join(tmpdir(), 'orch-fake-git-'))
  const bin = join(root, 'bin')
  const log = join(root, 'calls')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  rev-parse) printf 'tip\\n' ;;
  symbolic-ref) printf 'DEV-668-test\\n' ;;
  status) ;;
  show-ref) exit 1 ;;
  worktree) /bin/rm -rf "$4" ;;
esac
`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  directories.push(root)
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  return { log }
}

afterEach(() => {
  process.env.PATH = originalPath
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('worktree removal safety', () => {
  test('reader deletion accepts only this project clone or its partial reader directory', () => {
    const repoRoot = '/projects/alpha'
    expect(
      readOnlyRemovalRefusal({
        path: repoRoot,
        repoRoot,
        gitEntryExists: true,
        borrowedSource: repoRoot,
      }),
    ).toContain('main checkout or an ancestor')
    expect(
      readOnlyRemovalRefusal({
        path: '/projects',
        repoRoot,
        gitEntryExists: true,
        borrowedSource: repoRoot,
      }),
    ).toContain('main checkout or an ancestor')
    expect(
      readOnlyRemovalRefusal({
        path: '/projects/alpha/.claude/worktrees/orch-1',
        repoRoot,
        gitEntryExists: true,
        borrowedSource: '/projects/bravo',
      }),
    ).toContain('does not identify a reader clone borrowing')
    expect(
      readOnlyRemovalRefusal({
        path: '/tmp/orch-1',
        repoRoot,
        gitEntryExists: false,
        borrowedSource: null,
      }),
    ).toContain('has no .git and is outside')
    expect(
      readOnlyRemovalRefusal({
        path: '/projects/alpha/.claude/worktrees/orch-1',
        repoRoot,
        gitEntryExists: false,
        borrowedSource: null,
      }),
    ).toBeNull()
    expect(
      readOnlyRemovalRefusal({
        path: '/projects/alpha/.claude/worktrees/orch-1',
        repoRoot,
        gitEntryExists: true,
        borrowedSource: repoRoot,
      }),
    ).toBeNull()
  })

  test('forced fallback leaves a branch removeFor decided to keep', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-main-'))
    const path = join(repoRoot, 'tree')
    mkdirSync(path)
    writeFileSync(join(path, '.orch-run'), '1\n')
    directories.push(repoRoot)
    const git = fakeGit()
    upsertProject({
      name: 'remove-safety',
      path: repoRoot,
      settings: { worktree: { remove: 'exit 1' } },
    })

    const outcome = removeFor(
      {
        path,
        branch: 'DEV-668-test',
        base: 'base',
        repoRoot,
        source: 'recipe',
        mintedBranch: 'DEV-668-test',
      },
      repoRoot,
      true,
      true,
    )

    expect(outcome.removed).toBeTrue()
    expect(readFileSync(git.log, 'utf8')).not.toContain('branch -D DEV-668-test')
  })

  test('missing inline-recipe teardown fills the recorded path and never runs in main', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-root-'))
    const path = join(repoRoot, 'missing-tree')
    directories.push(repoRoot)
    const git = fakeGit()
    upsertProject({
      name: 'teardown-safety',
      path: repoRoot,
      settings: {
        worktree: {
          recipe: {
            stop:
              `test "{path}" = '${path}' && test "{name}" = 'missing-tree' && ` +
              `case "$(pwd -P)" in '${realpathSync(tmpdir())}'/orch-teardown-*) ;; *) exit 1 ;; esac`,
          },
        },
      },
    })

    const outcome = removeFor(
      {
        path,
        branch: 'DEV-668-test',
        base: 'base',
        repoRoot,
        source: 'recipe',
        mintedBranch: 'DEV-668-test',
      },
      repoRoot,
      false,
      true,
      668,
    )

    expect(outcome).toEqual({ removed: true, detail: `${path} was already gone` })
    expect(readFileSync(git.log, 'utf8')).not.toContain('branch -D DEV-668-test')
  })
})
