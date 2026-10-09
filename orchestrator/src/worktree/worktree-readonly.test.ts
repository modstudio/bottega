import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { projectAt, upsertProject } from '../project/projects.ts'
import {
  createReadOnlyWorktree,
  landingRemoteTrackingRefs,
  type RemoteTrackingRef,
} from './worktree-readonly.ts'

test('landing remote-tracking refs selects the landing branch on every remote', () => {
  const refs: RemoteTrackingRef[] = [
    { ref: 'refs/remotes/origin/develop', object: 'origin-develop' },
    { ref: 'refs/remotes/upstream/develop', object: 'upstream-develop' },
    { ref: 'refs/remotes/origin/topic', object: 'origin-topic' },
  ]

  expect(landingRemoteTrackingRefs([refs[0]!, refs[2]!], 'develop')).toEqual([refs[0]!])
  expect(landingRemoteTrackingRefs(refs, 'develop')).toEqual(refs.slice(0, 2))
  expect(landingRemoteTrackingRefs(refs, 'main')).toEqual([])
  expect(landingRemoteTrackingRefs(refs, null)).toEqual([])
})

test('built-in read-only trees are detached shared clones with private refs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-readonly-worktree-'))
  const runId = 828

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
        'initial',
      ],
      repoRoot,
    )
    const base = git(['rev-parse', 'HEAD'], repoRoot)
    const remoteRefs = join(repoRoot, '.git', 'refs', 'remotes', 'origin')
    mkdirSync(remoteRefs, { recursive: true })
    writeFileSync(join(remoteRefs, 'develop'), `${base}\n`)
    writeFileSync(join(remoteRefs, 'topic'), `${base}\n`)
    upsertProject({
      name: `readonly-worktree-${runId}`,
      path: realpathSync(repoRoot),
      settings: { trunk: 'develop' },
    })
    expect(projectAt(realpathSync(repoRoot))?.settings.trunk).toBe('develop')

    const worktree = createReadOnlyWorktree(repoRoot, runId, base)
    expect(statSync(join(worktree.path, '.git')).isDirectory()).toBe(true)
    expect(git(['rev-parse', 'HEAD', 'refs/remotes/origin/develop'], worktree.path)).toBe(
      `${base}\n${base}`,
    )
    expect(existsSync(join(worktree.path, '.git', 'refs', 'remotes', 'origin', 'topic'))).toBe(
      false,
    )
    expect(readFileSync(join(worktree.path, '.git', 'HEAD'), 'utf8').trim()).toBe(base)
    expect(
      readFileSync(join(worktree.path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(),
    ).toEndWith('/.git/objects')
    expect(readFileSync(join(worktree.path, '.git', 'config'), 'utf8')).not.toContain(
      '[remote "origin"]',
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
