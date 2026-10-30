import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { git } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { createReadOnlyWorktree } from './worktree-readonly.ts'
import {
  branchTip,
  changesInIndex,
  checkedOutBranchPath,
  readOnlyRemovalRefusal,
  removeBranch,
  removeFor,
  removeReadOnlyDirectory,
} from './worktree-remove.ts'

const directories: string[] = []
const originalPath = process.env.PATH

function fakeGit(localRefs = ''): { log: string } {
  const root = mkdtempSync(join(tmpdir(), 'orch-fake-git-'))
  const bin = join(root, 'bin')
  const log = join(root, 'calls')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  for-each-ref) printf '${localRefs}' ;;
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

test('an explicit observed-change lower bound bypasses base and merge-base selection', () => {
  const calls: string[] = []
  const result = changesInIndex(
    {
      path: '/tree',
      branch: 'DEV-1257-work',
      base: 'recorded-base',
      repoRoot: '/repo',
      source: 'git',
      mintedBranch: 'DEV-1257-work',
    },
    false,
    'architect-read',
    (args) => {
      calls.push(args.join(' '))
      return ''
    },
    (args) => {
      calls.push(args.join(' '))
      return ''
    },
    (args) => {
      calls.push(args.join(' '))
      return args[0] === 'diff' ? 'read-bounded patch' : ''
    },
  )

  expect(result.since).toBe('architect-read')
  expect(result.diff).toBe('read-bounded patch')
  expect(calls).not.toContain('merge-base HEAD main')
  expect(calls).toContain('diff --cached architect-read')
})

test('observed changes without an explicit bound still use the trunk merge-base', () => {
  const calls: string[] = []
  const result = changesInIndex(
    {
      path: '/tree',
      branch: 'DEV-1257-work',
      base: 'recorded-base',
      repoRoot: '/repo',
      source: 'git',
      mintedBranch: 'DEV-1257-work',
    },
    false,
    undefined,
    (args) => {
      calls.push(args.join(' '))
      return ''
    },
    (args) => {
      calls.push(args.join(' '))
      return args[0] === 'merge-base' ? 'trunk-merge-base' : ''
    },
    (args) => {
      calls.push(args.join(' '))
      return args[0] === 'diff' ? 'whole patch' : ''
    },
  )

  expect(result.since).toBe('trunk-merge-base')
  expect(result.diff).toBe('whole patch')
  expect(calls).toContain('merge-base HEAD main')
  expect(calls).toContain('diff --cached trunk-merge-base')
})

test('a branch cut ahead of the local trunk never diffs below its recorded base', () => {
  const calls: string[] = []
  const result = changesInIndex(
    {
      path: '/tree',
      branch: 'DEV-1257-work',
      base: 'run-base',
      repoRoot: '/repo',
      source: 'git',
      mintedBranch: 'DEV-1257-work',
    },
    false,
    undefined,
    (args) => {
      calls.push(args.join(' '))
      return ''
    },
    (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'merge-base') {
        // The local trunk still points at the caller's HEAD, below the base
        // this run's tree was cut from.
        return args.includes('--is-ancestor') ? null : 'caller-trunk-tip'
      }
      const since = args.at(-1)
      if (args.includes('--name-only'))
        return since === 'run-base' ? 'work.txt' : 'landed.txt\nwork.txt'
      if (args.includes('--numstat'))
        return since === 'run-base' ? '1\t0\twork.txt' : '1\t0\tlanded.txt\n1\t0\twork.txt'
      return ''
    },
    (args) => {
      calls.push(args.join(' '))
      return args[0] === 'diff' ? 'run patch' : ''
    },
  )

  expect(result.since).toBe('run-base')
  expect(result.files).toEqual(['work.txt'])
  expect(result.insertions).toBe(1)
  expect(calls).toContain('merge-base --is-ancestor run-base caller-trunk-tip')
  expect(calls).toContain('diff --cached run-base')
})

describe('worktree removal safety', () => {
  test('finds an exact branch that remains checked out in a registered worktree', () => {
    const porcelain = `worktree /projects/example
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /projects/example/.claude/worktrees/dev-1470
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/DEV-1470-guard
`

    expect(checkedOutBranchPath(porcelain, 'DEV-1470-guard')).toBe(
      '/projects/example/.claude/worktrees/dev-1470',
    )
    expect(checkedOutBranchPath(porcelain, 'dev-1470-guard')).toBeNull()
  })

  test('a branch tip read tolerates a missing repository', () => {
    const missing = join(tmpdir(), `orch-missing-repository-${crypto.randomUUID()}`)

    expect(branchTip(missing, 'DEV-1470-missing')).toBeNull()
  })

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

  test('a reader release that leaves provisioned residue reports failure', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-reader-residue-'))
    const runId = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
    let vendor = ''
    try {
      git(['init', '--initial-branch=main'], repoRoot)
      git(
        [
          '-c',
          'user.name=Orch Test',
          '-c',
          'user.email=orch@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'base',
        ],
        repoRoot,
      )
      const base = git(['rev-parse', 'HEAD'], repoRoot)
      const worktree = createReadOnlyWorktree(repoRoot, runId, base)
      vendor = join(worktree.path, 'vendor')
      const pkg = join(vendor, 'pkg')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'file'), 'provisioned\n')
      chmodSync(vendor, 0o500)

      const outcome = removeReadOnlyDirectory(worktree)

      expect(outcome.removed).toBeFalse()
      expect(outcome.detail).toContain(worktree.path)
      expect(existsSync(worktree.path)).toBeTrue()
    } finally {
      if (vendor && existsSync(vendor)) chmodSync(vendor, 0o700)
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('forced fallback leaves a branch removeFor decided to keep', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-main-'))
    const path = join(repoRoot, 'tree')
    mkdirSync(path)
    writeFileSync(join(path, '.orch-run'), '1\n')
    directories.push(repoRoot)
    const git = fakeGit()
    upsertProject({
      recordId: newRecordId(),
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
      recordId: newRecordId(),
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
      'run-record-id-668',
    )

    expect(outcome).toEqual({ removed: true, detail: `${path} was already gone` })
    expect(readFileSync(git.log, 'utf8')).not.toContain('branch -D DEV-668-test')
  })

  test('a case peer prevents the project remover from running when the exact branch is absent', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-case-peer-'))
    const path = join(repoRoot, 'tree')
    const removerRan = join(repoRoot, 'remover-ran')
    mkdirSync(path)
    directories.push(repoRoot)
    fakeGit('worktree-DEV-1470-case\\tpeer-tip\\n')
    upsertProject({
      recordId: newRecordId(),
      name: `remove-case-peer-${Date.now()}`,
      path: repoRoot,
      settings: { worktree: { remove: `touch '${removerRan}'` } },
    })

    const outcome = removeFor(
      {
        path,
        branch: 'worktree-dev-1470-case',
        base: 'base',
        repoRoot,
        source: 'recipe',
        mintedBranch: 'worktree-dev-1470-case',
      },
      repoRoot,
    )

    expect(outcome.removed).toBeFalse()
    expect(outcome.detail).toContain('worktree-dev-1470-case')
    expect(outcome.detail).toContain('worktree-DEV-1470-case')
    expect(existsSync(removerRan)).toBeFalse()
  })

  test('branch deletion refuses when the exact tip moved after classification', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'orch-remove-moved-tip-'))
    directories.push(repoRoot)
    const git = fakeGit('DEV-1470-moved\\tnew-tip\\n')

    expect(() => removeBranch(repoRoot, 'DEV-1470-moved', 'classified-tip')).toThrow(
      'branch moved since it was classified',
    )
    expect(readFileSync(git.log, 'utf8')).not.toContain('update-ref -d')
  })
})
