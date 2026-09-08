import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, db, formatGitLocks, hermeticGitEnv, land, landingReviewCoverage, landingStatus, resolveLandingBranch, setPostLandMigrateForFixture, upsertProject } from '../test/fixture.ts'

import { landingDescribeFixture } from '../test/fixture.ts'

describe("landing is gated on the exact commit that reaches trunk", () => {
  const { g, repoWithBranches, childLand, observeGitLocks, completedReview } = landingDescribeFixture()
test('an explicit non-empty override lands and records the measured tree and reason', async () => {
    const { repo } = repoWithBranches(['override-review'])
    const project = 'landing-override-review'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const child = childLand(repo, 'override-review', { unreviewed: 'incident recovery' })
      expect(await child.exited).toBe(0)
      const row = db().query(
        'SELECT project, branch, tip, tree, reason FROM landing_override WHERE branch=?',
      ).get('override-review') as Record<string, string>
      expect(row).toEqual({ project, branch: 'override-review',
        tip: g(repo, 'rev-parse', 'override-review'),
        tree: g(repo, 'rev-parse', 'override-review^{tree}'), reason: 'incident recovery' })
      const notice = await new Response(child.stderr).text()
      expect(notice).toContain('UNREVIEWED LANDING OVERRIDE')
      const empty = repoWithBranches(['empty-override'])
      upsertProject({ name: 'landing-empty-override', path: empty.repo,
        settings: { trunk: 'main', gate: 'true' } })
      try {
        const refused = Bun.spawnSync(
          [process.execPath, new URL('cli.ts', import.meta.url).pathname,
            'land', 'empty-override', '--unreviewed', ''],
          { cwd: empty.repo, env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
            stdout: 'pipe', stderr: 'pipe' },
        )
        expect(refused.exitCode).not.toBe(0)
        expect(refused.stderr.toString()).toContain('--unreviewed requires a non-empty reason')
      } finally { rmSync(empty.repo, { recursive: true, force: true }) }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a failed fast-forward does not record an announced override', async () => {
    const { repo } = repoWithBranches(['override-refused'])
    const project = 'landing-override-refused'
    const hooks = join(repo, '.git', 'reject-main-hooks')
    mkdirSync(hooks)
    const hook = join(hooks, 'reference-transaction')
    writeFileSync(hook, [
      '#!/bin/sh',
      '[ "$1" = prepared ] || exit 0',
      'while read old new ref; do',
      '  [ "$ref" != refs/heads/main ] || exit 1',
      'done',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(hook, 0o755)
    g(repo, 'config', 'core.hooksPath', hooks)
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const trunk = g(repo, 'rev-parse', 'main')
      const child = childLand(repo, 'override-refused', { unreviewed: 'emergency' })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('UNREVIEWED LANDING OVERRIDE')
      expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
      expect(db().query(
        'SELECT id FROM landing_override WHERE branch=?',
      ).get('override-refused')).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a failing post-land hub migrate records that landing succeeded and install failed', () => {
    const { repo, trees } = repoWithBranches(['post-step-hub'])
    const tree = trees['post-step-hub']!
    mkdirSync(join(tree, 'orchestrator', 'migrations'), { recursive: true })
    writeFileSync(join(tree, 'orchestrator', 'migrations', 'note.sql'), '-- journal\n')
    g(tree, 'add', 'orchestrator/migrations/note.sql')
    g(tree, 'commit', '-m', 'journal')
    upsertProject({ name: 'landing-post-step', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const stubDir = mkdtempSync(join(tmpdir(), 'orch-hub-stub-'))
    const stub = join(stubDir, 'hub')
    writeFileSync(stub, '#!/bin/sh\necho stub-fail >&2\nexit 1\n')
    chmodSync(stub, 0o755)
    setPostLandMigrateForFixture({
      orchBin: '/usr/bin/true',
      hubBin: stub,
    })
    try {
      expect(() => land(repo, 'post-step-hub', { unreviewed: 'post-step fixture' })).toThrow(
        'landing reached trunk at',
      )
      const row = db().query(
        `SELECT status, error FROM landing WHERE branch=?`,
      ).get('post-step-hub') as { status: string; error: string }
      expect(row.status).toBe('install_failed')
      expect(row.error).toContain('landing reached trunk at')
      expect(row.error).toContain('hub migrate failed')
      expect(row.error).toContain('stub-fail')
      const status = landingStatus(repo)
      expect(status).toContain('landed with post-step error')
      expect(status).toContain(row.error)
    } finally {
      setPostLandMigrateForFixture(null)
      rmSync(repo, { recursive: true, force: true })
      rmSync(stubDir, { recursive: true, force: true })
    }
  })

  test('run ids resolve explicitly and status reads holder and waiters without acquiring', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET branch=? WHERE id=?').run('DEV-181-branch', id)
    expect(resolveLandingBranch(String(id))).toEqual({ branch: 'DEV-181-branch', runId: id })
    expect(resolveLandingBranch('named-branch')).toEqual({ branch: 'named-branch', runId: null })
    const { repo } = repoWithBranches([])
    upsertProject({ name: 'landing-status', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const tree = g(repo, 'rev-parse', 'HEAD^{tree}')
      expect(landingStatus(repo)).toContain('landing-status landing lock: free')
      expect(landingStatus(repo)).toContain('waiters:\n  none')
      expect(landingStatus(repo)).toContain('queue lock: free')
      expect(landingStatus(repo)).toContain('queue:\n  none')
      expect(landingStatus(repo)).toContain('invalidated today:\n  none')
      expect(landingReviewCoverage(repo)).toBe(
        `review coverage for main:\ncurrent tip tree: ${tree}\n  none`,
      )
    }
    finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing binds confinement failures to the selected or current chain', async () => {
    const { repo, trees } = repoWithBranches([
      'escaped-root', 'escaped-turn', 'discarded-owner', 'reused', 'unowned',
    ])
    const project = 'landing-escaped'
    upsertProject({ name: project, path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    try {
      const root = addRun({
        agent: 'grok', job: 'implement', status: 'failed', kind: 'escaped', repo: project,
      })
      db().query('UPDATE run SET branch=?, worktree=? WHERE id=?')
        .run('escaped-root', trees['escaped-root']!, root)

      const chainRoot = addRun({
        agent: 'grok', job: 'implement', status: 'failed', repo: project,
      })
      db().query('UPDATE run SET branch=?, worktree=? WHERE id=?')
        .run('escaped-turn', trees['escaped-turn']!, chainRoot)
      const turn = addRun({
        agent: 'grok', job: 'implement', status: 'failed', kind: 'confinement_unverified',
        parent: chainRoot, turn: 2, repo: project,
      })

      for (const [branch, runId, options] of [
        ['escaped-root', root, { unreviewed: 'operator override', runId: root }],
        ['escaped-turn', turn, { unreviewed: 'operator override' }],
      ] as const) {
        const trunk = g(repo, 'rev-parse', 'main')
        const child = childLand(trees[branch]!, branch, options)
        expect(await child.exited).not.toBe(0)
        const error = await new Response(child.stderr).text()
        expect(error).toContain(`run ${runId}`)
        expect(error).toContain(branch === 'escaped-root' ? 'escaped' : 'confinement_unverified')
        expect(error).toContain('--unreviewed cannot override it')
        expect(g(repo, 'rev-parse', 'main')).toBe(trunk)
      }

      const discarded = addRun({ agent: 'grok', job: 'implement', repo: project })
      db().query('UPDATE run SET branch=?, worktree=NULL, branch_kept=? WHERE id=?')
        .run('discarded-owner', 'discarded-owner', discarded)
      const unresolved = childLand(
        trees['discarded-owner']!, 'discarded-owner', { unreviewed: 'must not bypass ownership' },
      )
      expect(await unresolved.exited).not.toBe(0)
      expect(await new Response(unresolved.stderr).text()).toContain(
        'cannot resolve the owning chain of discarded-owner (runs ',
      )

      const old = addRun({
        agent: 'grok', job: 'implement', status: 'failed', kind: 'escaped', repo: project,
      })
      db().query('UPDATE run SET branch=?, worktree=? WHERE id=?').run('reused', '/old/tree', old)
      const current = addRun({ agent: 'grok', job: 'implement', repo: project })
      db().query('UPDATE run SET branch=?, worktree=? WHERE id=?')
        .run('reused', trees.reused!, current)
      const reused = childLand(trees.reused!, 'reused', { unreviewed: 'current chain is safe' })
      expect(await reused.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', 'reused'))

      const unowned = childLand(trees.unowned!, 'unowned', { unreviewed: 'no recorded owner' })
      expect(await unowned.exited).toBe(0)
      expect(g(repo, 'rev-parse', 'main')).toBe(g(repo, 'rev-parse', 'unowned'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  // Five child landings in one test. DEV-348 added preflight work to each
  // landing (sequencer-state check, trunk symbolic-ref sample, tier and
  // dependency delta), so the five together crossed bun's 5 s default under
  // any parallel load: four full gates timed out here on 2026-09-07 and the
  // DEV-347 shard rebalance did not cure it. The bound is sized to the work,
  // not widened to hide a load failure; each child still exits on its own.
  }, 60_000)

  test('status reports a stale ref lock with age, recoverable contents, resolved ref, and no live owner', () => {
    const { repo } = repoWithBranches(['lock-source'])
    upsertProject({ name: 'landing-git-lock', path: repo,
      settings: { trunk: 'main', gate: 'true' } })
    const lock = join(repo, '.git', 'refs', 'heads', 'main.lock')
    const oid = g(repo, 'rev-parse', 'refs/heads/lock-source')
    writeFileSync(lock, `${oid}\n`)
    const stale = new Date(Date.now() - 71_000)
    utimesSync(lock, stale, stale)
    try {
      const { status, locks } = observeGitLocks(repo)
      expect(status).toContain('landing-git-lock landing lock: free')
      expect(status).toContain('waiters:\n  none')
      expect(status).toContain('queue lock: free')
      expect(status).toContain('invalidated today:\n  none')
      const formatted = formatGitLocks(repo)
      expect(formatted).toContain(`${lock} (age `)
      expect(Number(formatted.match(/main\.lock \(age (\d+)s\)/)?.[1])).toBeGreaterThanOrEqual(70)
      expect(formatted).toContain('target: refs/heads/main')
      expect(formatted).toContain(`contents: ${oid} -> refs/heads/lock-source`)
      expect(formatted).toContain('owner pid: none alive')
      expect(readFileSync(lock, 'utf8')).toBe(`${oid}\n`)
      expect(locks).toEqual([expect.objectContaining({
        path: lock, target: 'refs/heads/main', contents: oid,
        contentRefs: ['refs/heads/lock-source'], ownerPids: [],
      })])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('amending the message happens before the gate and the gated commit is what reaches trunk', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-land-amend-')))
    g(repo, 'init', '-b', 'main')
    g(repo, 'config', 'user.email', 'orch-test@example.invalid')
    g(repo, 'config', 'user.name', 'Orch Test')
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'trees/\n.orch-run\n')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    g(repo, 'add', 'base.txt')
    g(repo, 'commit', '-m', 'base')
    const branch = 'run-amend'
    const tree = join(repo, 'trees', branch)
    mkdirSync(join(repo, 'trees'), { recursive: true })
    g(repo, 'worktree', 'add', '-b', branch, tree, 'main')
    writeFileSync(join(tree, '.orch-run'), `59999\n${repo}\nsource: git\n`)
    writeFileSync(join(tree, 'work.txt'), 'work\n')
    g(tree, 'add', 'work.txt')
    const authored = Bun.spawnSync(['git', 'commit', '-m', 'worker short message'], {
      cwd: tree, env: hermeticGitEnv({
        GIT_AUTHOR_NAME: 'Worker Identity',
        GIT_AUTHOR_EMAIL: 'worker@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-15T12:00:00 +0000',
        GIT_COMMITTER_NAME: 'Worker Identity',
        GIT_COMMITTER_EMAIL: 'worker@example.invalid',
        GIT_COMMITTER_DATE: '2026-01-15T12:00:00 +0000',
      }), stdout: 'pipe', stderr: 'pipe',
    })
    if (authored.exitCode !== 0) throw new Error(authored.stderr.toString())
    const before = g(tree, 'log', '-1', '--format=%H%n%an <%ae>%n%cn <%ce>%n%s')
    const gate = join(repo, 'gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\ngit rev-parse HEAD > '${repo}/gated.oid'\n`)
    chmodSync(gate, 0o755)
    upsertProject({ name: 'landing-amend', path: repo, settings: { trunk: 'main', gate } })
    try {
      const child = childLand(repo, branch, { message: 'architect fuller message' }, {
        GIT_COMMITTER_NAME: 'Architect Identity',
        GIT_COMMITTER_EMAIL: 'architect@example.invalid',
        GIT_COMMITTER_DATE: '2026-09-04T18:00:00 +0000',
      })
      expect(await child.exited).toBe(0)
      const gated = readFileSync(join(repo, 'gated.oid'), 'utf8').trim()
      const landed = g(repo, 'rev-parse', 'refs/heads/main')
      expect(gated).toBe(landed)
      expect(g(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(landed)
      expect(g(repo, 'log', '-1', '--format=%an <%ae>', 'main'))
        .toBe('Worker Identity <worker@example.invalid>')
      expect(g(repo, 'log', '-1', '--format=%cn <%ce>', 'main'))
        .toBe('Architect Identity <architect@example.invalid>')
      expect(g(repo, 'log', '-1', '--format=%s', 'main')).toBe('architect fuller message')
      expect(landed).not.toBe(before.split('\n')[0])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing a run with a new message leaves the run branch reachable from trunk so discard does not keep it', async () => {
    const { repo, trees } = repoWithBranches(['land-then-discard'])
    const tree = trees['land-then-discard']!
    upsertProject({
      name: 'landing-then-discard', path: repo, settings: { trunk: 'main', gate: 'true' },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree, 'land-then-discard', 'land-then-discard', id)
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const cliEnv = {
      ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'landing-discard-owner',
    }
    try {
      const landed = Bun.spawnSync(
        [process.execPath, CLI, 'land', String(id), '--wait', '--message', 'architect fuller message',
          '--unreviewed', 'existing landing fixture'],
        { cwd: repo, env: cliEnv, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(landed.exitCode).toBe(0)
      expect(g(repo, 'merge-base', '--is-ancestor', 'land-then-discard', 'main')).toBe('')
      expect(g(repo, 'rev-parse', 'refs/heads/land-then-discard'))
        .toBe(g(repo, 'rev-parse', 'refs/heads/main'))
      const discarded = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id)],
        { cwd: repo, env: cliEnv, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(discarded.exitCode).toBe(0)
      const discardOut = discarded.stdout.toString() + discarded.stderr.toString()
      expect(discardOut).not.toContain('kept branch')
      expect(discardOut).not.toContain('--force')
      expect(g(repo, 'branch', '--list', 'land-then-discard')).toBe('')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('landing reads the amended message from --file', async () => {
    const { repo } = repoWithBranches(['land-from-file'])
    const body = join(repo, 'landing-message.txt')
    writeFileSync(body, 'architect fuller message from a file\n')
    upsertProject({
      name: 'landing-from-file', path: repo, settings: { trunk: 'main', gate: 'true' },
    })
    const CLI = new URL('cli.ts', import.meta.url).pathname
    try {
      const landed = Bun.spawnSync(
        [process.execPath, CLI, 'land', 'land-from-file', '--wait', '--file', body,
          '--unreviewed', 'existing landing fixture'],
        { cwd: repo, env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe' },
      )
      expect(landed.exitCode).toBe(0)
      expect(g(repo, 'log', '-1', '--format=%s', 'main')).toBe('architect fuller message from a file')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an empty landing message is refused before the branch moves', async () => {
    const { repo } = repoWithBranches(['empty-message'])
    const trunk = g(repo, 'rev-parse', 'refs/heads/main')
    upsertProject({
      name: 'landing-empty-message', path: repo, settings: { trunk: 'main', gate: 'true' },
    })
    try {
      const child = childLand(repo, 'empty-message', { message: '   \n' })
      expect(await child.exited).not.toBe(0)
      expect((await new Response(child.stderr).text())).toContain('landing message is empty')
      expect(g(repo, 'rev-parse', 'refs/heads/main')).toBe(trunk)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('amending refuses a dirty worktree and does not land', async () => {
    const { repo, trees } = repoWithBranches(['dirty-amend'])
    writeFileSync(join(trees['dirty-amend']!, 'dirty-amend.txt'), 'unstaged\n')
    const trunk = g(repo, 'rev-parse', 'refs/heads/main')
    upsertProject({
      name: 'landing-dirty-amend', path: repo, settings: { trunk: 'main', gate: 'true' },
    })
    try {
      const child = childLand(repo, 'dirty-amend', { message: 'architect fuller message' })
      expect(await child.exited).not.toBe(0)
      expect((await new Response(child.stderr).text())).toContain('uncommitted tracked changes')
      expect(g(repo, 'rev-parse', 'refs/heads/main')).toBe(trunk)
      expect(g(repo, 'log', '-1', '--format=%s', 'dirty-amend')).toBe('dirty-amend')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a completed review whose branch repo path is missing does not change landed status', async () => {
    const { repo, trees } = repoWithBranches(['lander', 'victim'])
    const project = 'landing-contention-missing-path'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      completedReview(project, [g(trees.victim!, 'rev-parse', 'HEAD^{tree}')], {
        branch: 'victim', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees.victim!,
      })
      rmSync(trees.victim!, { recursive: true, force: true })
      const child = childLand(repo, 'lander')
      expect(await child.exited).toBe(0)
      expect(db().query(
        "SELECT status FROM landing WHERE branch='lander'",
      ).get()).toEqual({ status: 'landed' })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a disjoint trunk move does not record a review invalidation', async () => {
    const { repo, trees } = repoWithBranches(['lander', 'victim'])
    const project = 'landing-contention-invalidation'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      completedReview(project, [g(trees.victim!, 'rev-parse', 'HEAD^{tree}')], {
        branch: 'victim', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees.victim!,
      })
      const child = childLand(repo, 'lander')
      expect(await child.exited).toBe(0)
      expect(db().query(
        "SELECT id FROM landing WHERE branch='lander' AND status='landed'",
      ).get()).toBeDefined()
      expect(db().query(
        "SELECT 1 FROM contention WHERE event_kind='invalidation'",
      ).get()).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an overlapping-path landing records one review invalidation', async () => {
    const { repo, trees } = repoWithBranches(['lander', 'victim'])
    const project = 'landing-contention-overlap'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      writeFileSync(join(trees.lander!, 'base.txt'), 'lander\n')
      g(trees.lander!, 'add', 'base.txt')
      g(trees.lander!, 'commit', '-m', 'overlap-lander')
      writeFileSync(join(trees.victim!, 'base.txt'), 'victim\n')
      g(trees.victim!, 'add', 'base.txt')
      g(trees.victim!, 'commit', '-m', 'overlap-victim')
      const reviewId = completedReview(project, [g(trees.victim!, 'rev-parse', 'HEAD^{tree}')], {
        branch: 'victim', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees.victim!,
      })
      const child = childLand(repo, 'lander')
      expect(await child.exited).toBe(0)
      const landing = db().query(
        "SELECT id FROM landing WHERE branch='lander' AND status='landed'",
      ).get() as { id: number }
      expect(db().query(
        `SELECT resource_kind, event_kind, resource_key, landing_id, cause
           FROM contention WHERE event_kind='invalidation'`,
      ).get()).toEqual({
        resource_kind: 'review', event_kind: 'invalidation', resource_key: 'victim',
        landing_id: landing.id, cause: `review ${reviewId}`,
      })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('passing both --message and --file is refused', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'land', '12', '--message', 'one', '--file', 'two'],
      { env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(p.exitCode).not.toBe(0)
    expect(p.stderr.toString() + p.stdout.toString()).toContain('pass --message or --file, not both')
  })
})
