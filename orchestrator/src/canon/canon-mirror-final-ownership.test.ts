import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a foreign snapshot at a matching remote tip does not establish ownership', async () => {
  const root = mirrorRepository('cm-foreign-snapshot')
  const tip = '0123456789abcdef0123456789abcdef01234567'
  try {
    await registerManagedMirror(root, 'cm-foreign-snapshot')
    db()
      .query(
        `INSERT INTO landing_triage_snapshot
       (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
       VALUES ('foreign-snapshot','cm-foreign-snapshot','DEV-1002-canon-mirror',?, 'tree',9,'[]','patch',0,0,0,'2026-09-28')`,
      )
      .run(tip)
    const result = await mirrorRepositoryCanon({
      project: 'cm-foreign-snapshot',
      dryRun: false,
      port: mirrorFixturePort(root, { remoteBranchTip: () => tip }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain(tip)
    expect(result[0]?.text).not.toContain('output withheld')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a push followed by a failed PR step is reclaimed by its recorded run tip', async () => {
  const root = mirrorRepository('cm-reclaim-push')
  let remote: string | null = null
  const leases: Array<string | null> = []
  try {
    await registerManagedMirror(root, 'cm-reclaim-push')
    const first = mirrorFixturePort(root, {
      remoteBranchTip: () => remote,
      push: (path, _branch, expected) => {
        leases.push(expected)
        remote = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: path }).stdout.toString().trim()
      },
      openPullRequest: () => {
        throw new Error('fixture PR failure after push')
      },
    })
    await mirrorRepositoryCanon({
      project: 'cm-reclaim-push',
      dryRun: false,
      port: first,
      noteFailure: async () => {},
    })
    const owned = remote
    const second = mirrorFixturePort(root, {
      remoteBranchTip: () => remote,
      push: (path, _branch, expected) => {
        leases.push(expected)
        remote = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: path }).stdout.toString().trim()
      },
      openPullRequest: (path) => ({
        number: 8,
        url: 'https://example.test/pull/8',
        headSha: spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: path }).stdout.toString().trim(),
        headRef: 'DEV-1002-canon-mirror',
        baseRef: 'main',
        checks: 'passed',
      }),
    })
    const result = await mirrorRepositoryCanon({
      project: 'cm-reclaim-push',
      dryRun: false,
      port: second,
      noteFailure: async () => {},
    })
    expect(leases).toEqual([null, owned])
    expect(result[0]?.failed).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the merge freshness decision reads the live remote trunk', async () => {
  const root = mirrorRepository('cm-live-trunk')
  let liveReads = 0
  try {
    await registerManagedMirror(root, 'cm-live-trunk')
    const port = mirrorFixturePort(root, {
      remoteTrunkTip: () => {
        liveReads += 1
        return 'moved-remote-tip'
      },
      openPullRequest: (path) => ({
        number: 10,
        url: 'https://example.test/pull/10',
        headSha: spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: path }).stdout.toString().trim(),
        headRef: 'DEV-1002-canon-mirror',
        baseRef: 'main',
        checks: 'passed',
      }),
    })
    const result = await mirrorRepositoryCanon({
      project: 'cm-live-trunk',
      dryRun: false,
      port,
      noteFailure: async () => {},
    })
    expect(liveReads).toBeGreaterThan(0)
    expect(result[0]?.text).toContain('landing branch changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update-ref branch release refuses a branch that moved', () => {
  const root = mirrorRepository('cm-update-ref')
  try {
    const original = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root })
      .stdout.toString()
      .trim()
    spawnFixtureGitSync(['branch', 'DEV-1002-canon-mirror', original], { cwd: root })
    spawnFixtureGitSync(['commit', '--allow-empty', '-m', 'foreign move'], { cwd: root })
    const moved = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
    spawnFixtureGitSync(['branch', '-f', 'DEV-1002-canon-mirror', moved], { cwd: root })
    const project = { path: root } as Parameters<typeof systemCanonMirrorPort.releaseBranch>[0]
    expect(() =>
      systemCanonMirrorPort.releaseBranch(project, 'DEV-1002-canon-mirror', original),
    ).toThrow()
    expect(
      spawnFixtureGitSync(['rev-parse', 'DEV-1002-canon-mirror'], { cwd: root })
        .stdout.toString()
        .trim(),
    ).toBe(moved)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
