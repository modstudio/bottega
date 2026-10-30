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
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { git } from '../git/git-environment.ts'
import { projectAt, upsertProject } from '../project/projects.ts'
import {
  createReadOnlyWorktree,
  landingRemoteTrackingRefs,
  parseRemoteTrackingRefs,
  type RemoteTrackingRef,
  resolveSharedReadOnlyWorktree,
  sharedReviewWorktreePath,
} from './worktree-readonly.ts'

test('shared review readers attach once and a dirty candidate falls back to an own clone', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-shared-review-worktree-'))
  const first = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
  const second = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
  const third = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
  try {
    git(['init', '--initial-branch=main'], repoRoot)
    writeFileSync(join(repoRoot, 'tracked.txt'), 'clean\n')
    git(['add', 'tracked.txt'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '-m',
        'base',
      ],
      repoRoot,
    )
    const commit = git(['rev-parse', 'HEAD'], repoRoot)
    const records: string[] = []
    const resolveFor = (runId: string) =>
      resolveSharedReadOnlyWorktree({
        cwd: repoRoot,
        runId,
        commit,
        record: (tree) => records.push(`${runId}:${tree.path}`),
      })

    const created = resolveFor(first)
    const attached = resolveFor(second)
    expect(created.worktree.path).toBe(realpathSync(sharedReviewWorktreePath(repoRoot, commit)))
    expect(attached.worktree.path).toBe(created.worktree.path)
    expect(records).toHaveLength(2)

    writeFileSync(join(created.worktree.path, 'tracked.txt'), 'escaped\n')
    const fallback = resolveFor(third)
    expect(fallback.shared).toBeFalse()
    expect(fallback.fallbackReason).toContain('does not agree with HEAD')
    expect(fallback.worktree.path).not.toBe(created.worktree.path)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('landing remote-tracking refs selects the landing branch on every remote', () => {
  const refs: RemoteTrackingRef[] = [
    { ref: 'refs/remotes/origin/develop', object: 'origin-develop' },
    { ref: 'refs/remotes/upstream/develop', object: 'upstream-develop' },
    { ref: 'refs/remotes/origin/topic', object: 'origin-topic' },
    { ref: 'refs/remotes/origin/feature/develop', object: 'origin-feature-develop' },
  ]

  expect(landingRemoteTrackingRefs([refs[0]!, refs[2]!], 'develop')).toEqual([refs[0]!])
  expect(landingRemoteTrackingRefs(refs, 'develop')).toEqual(refs.slice(0, 2))
  expect(landingRemoteTrackingRefs(refs, 'main')).toEqual([])
  expect(landingRemoteTrackingRefs(refs, null)).toEqual([])
})

test('landing remote-tracking refs matches a slash-containing landing branch whole', () => {
  const refs: RemoteTrackingRef[] = [
    { ref: 'refs/remotes/origin/release/main', object: 'release-main' },
    { ref: 'refs/remotes/origin/main', object: 'main' },
  ]

  expect(landingRemoteTrackingRefs(refs, 'release/main')).toEqual([refs[0]!])
})

test('remote-tracking ref output skips malformed lines', () => {
  expect(
    parseRemoteTrackingRefs(
      [
        'refs/remotes/origin/develop\t1111111111111111111111111111111111111111',
        'missing-object',
        '\t2222222222222222222222222222222222222222',
        'refs/remotes/upstream/develop\t3333333333333333333333333333333333333333',
      ].join('\n'),
    ),
  ).toEqual([
    {
      ref: 'refs/remotes/origin/develop',
      object: '1111111111111111111111111111111111111111',
    },
    {
      ref: 'refs/remotes/upstream/develop',
      object: '3333333333333333333333333333333333333333',
    },
  ])
})

test('built-in read-only trees are detached shared clones with private refs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-readonly-worktree-'))
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })

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
      recordId: newRecordId(),
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
