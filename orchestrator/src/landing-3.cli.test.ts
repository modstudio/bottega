import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addRun, db, drainQueue, hermeticGitEnv, land, landingStatus, upsertProject,
} from '../test/fixture.ts'
import { landingDescribeFixture } from '../test/fixture.ts'

describe('DEV-370 landing queue and branch ownership', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const { g, repoWithBranches, childLand } = landingDescribeFixture()

  test('two sessions enqueue and both land without a hand-off', async () => {
    const { repo } = repoWithBranches(['queue-a', 'queue-b'])
    upsertProject({ name: 'landing-queue-two', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      const first = childLand(repo, 'queue-a', { unreviewed: 'queue-a' }, {
        CLAUDE_CODE_SESSION_ID: 'session-a',
      })
      const second = childLand(repo, 'queue-b', { unreviewed: 'queue-b' }, {
        CLAUDE_CODE_SESSION_ID: 'session-b',
      })
      expect(await first.exited).toBe(0)
      expect(await second.exited).toBe(0)
      const files = g(repo, 'ls-tree', '-r', '--name-only', 'main')
      expect(files).toContain('queue-a.txt')
      expect(files).toContain('queue-b.txt')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a red merge-group refuses only the culprit', () => {
    const { repo, trees } = repoWithBranches(['group-ok', 'group-bad'])
    writeFileSync(join(trees['group-bad']!, 'fail-gate.txt'), 'no\n')
    g(trees['group-bad']!, 'add', 'fail-gate.txt')
    g(trees['group-bad']!, 'commit', '-m', 'fail-gate')
    const gate = `test ! -f ${join('fail-gate.txt')}`
    upsertProject({ name: 'landing-bisect', path: repo, settings: { trunk: 'main', gate } })
    try {
      land(repo, 'group-ok', { unreviewed: 'ok', wait: false })
      land(repo, 'group-bad', { unreviewed: 'bad', wait: false })
      try { drainQueue(repo) } catch { /* culprit refused */ }
      const rows = db().query(
        `SELECT branch, status FROM landing WHERE project='landing-bisect' ORDER BY id`,
      ).all() as { branch: string; status: string }[]
      const byBranch = Object.fromEntries(rows.map((row) => [row.branch, row.status]))
      expect(byBranch['group-ok']).toBe('landed')
      expect(byBranch['group-bad']).toBe('refused')
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain('group-ok.txt')
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('fail-gate.txt')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an overlapping queued landing is marked rebase_required and a disjoint one is not', () => {
    const { repo, trees } = repoWithBranches(['overlap-a', 'disjoint-c'])
    writeFileSync(join(trees['overlap-a']!, 'shared.txt'), 'a\n')
    g(trees['overlap-a']!, 'add', 'shared.txt')
    g(trees['overlap-a']!, 'commit', '-m', 'shared-a')
    upsertProject({ name: 'landing-overlap', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      land(repo, 'overlap-a', { unreviewed: 'overlap-a' })
      const now = new Date().toISOString()
      db().query(
        `INSERT INTO landing (project, branch, status, session_id, started_at, requested_at, path_set)
         VALUES ('landing-overlap', 'queued-overlap', 'queued', 'other', ?, ?, ?)`,
      ).run(now, now, JSON.stringify(['shared.txt']))
      db().query(
        `INSERT INTO landing (project, branch, status, session_id, started_at, requested_at, path_set)
         VALUES ('landing-overlap', 'queued-disjoint', 'queued', 'other', ?, ?, ?)`,
      ).run(now, now, JSON.stringify(['unrelated.txt']))
      const follow = join(repo, 'trees', 'overlap-follow')
      g(repo, 'worktree', 'add', '-b', 'overlap-follow', follow, 'main')
      writeFileSync(join(follow, 'shared.txt'), 'follow\n')
      g(follow, 'add', 'shared.txt')
      g(follow, 'commit', '-m', 'shared-follow')
      land(repo, 'overlap-follow', { unreviewed: 'follow' })
      const overlap = db().query(
        `SELECT status, causing_landing_id FROM landing WHERE branch='queued-overlap'`,
      ).get() as { status: string; causing_landing_id: number | null }
      const disjoint = db().query(
        `SELECT status FROM landing WHERE branch='queued-disjoint'`,
      ).get() as { status: string }
      expect(overlap.status).toBe('rebase_required')
      expect(overlap.causing_landing_id).not.toBeNull()
      expect(disjoint.status).toBe('queued')
      land(repo, 'disjoint-c', { unreviewed: 'disjoint' })
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain('disjoint-c.txt')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('stop keeps a review subject branch and deletes a minted implement branch', () => {
    const { repo, trees } = repoWithBranches(['DEV-370-subject'])
    const subject = trees['DEV-370-subject']!
    const subjectTip = g(repo, 'rev-parse', 'DEV-370-subject')
    const reviewTree = join(repo, 'trees', 'review-detached')
    mkdirSync(join(repo, 'trees'), { recursive: true })
    g(repo, 'worktree', 'add', '--detach', reviewTree, 'DEV-370-subject')
    const reviewId = addRun({ agent: 'codex', job: 'review-lens', status: 'running', repo: 'landing-stop' })
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=NULL, worktree_source='git', base_commit=? WHERE id=?`,
    ).run(reviewTree, 'DEV-370-subject', subjectTip, reviewId)
    upsertProject({ name: 'landing-stop', path: repo, settings: { trunk: 'main', gate: 'true' } })
    db().query(`UPDATE run SET session_id='landing-stop-session' WHERE id=?`).run(reviewId)
    const stopReview = Bun.spawnSync([process.execPath, CLI, 'stop', String(reviewId)], {
      cwd: repo, env: {
        ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'landing-stop-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(stopReview.exitCode, stopReview.stderr.toString()).toBe(0)
    expect(stopReview.stdout.toString()).toContain(
      `branch DEV-370-subject kept (review subject, not owned by run ${reviewId})`,
    )
    expect(g(repo, 'rev-parse', 'DEV-370-subject')).toBe(subjectTip)

    const mintedId = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: 'landing-stop' })
    const mintedRef = `orch/${mintedId}`
    const mintedTree = join(repo, 'trees', `orch-${mintedId}`)
    g(repo, 'worktree', 'add', '-b', mintedRef, mintedTree, 'main')
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, worktree_source='git', session_id=? WHERE id=?`,
    ).run(mintedTree, mintedRef, mintedRef, 'landing-stop-session', mintedId)
    const stopMinted = Bun.spawnSync([process.execPath, CLI, 'stop', String(mintedId)], {
      cwd: repo, env: {
        ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'landing-stop-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(stopMinted.exitCode, stopMinted.stderr.toString()).toBe(0)
    expect(Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${mintedRef}`], {
      cwd: repo, env: hermeticGitEnv(),
    }).exitCode).not.toBe(0)
  })

  test('a journal landing with a live run records store/invalidation and names the run', () => {
    const { repo, trees } = repoWithBranches(['journal-land'])
    const tree = trees['journal-land']!
    mkdirSync(join(tree, 'orchestrator', 'migrations'), { recursive: true })
    writeFileSync(join(tree, 'orchestrator', 'migrations', 'note.sql'), '-- journal\n')
    g(tree, 'add', 'orchestrator/migrations/note.sql')
    g(tree, 'commit', '-m', 'journal')
    upsertProject({ name: 'landing-strand', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: 'landing-strand' })
    try {
      expect(() => land(repo, 'journal-land', { unreviewed: 'journal', timeoutMs: 400 })).toThrow('strand live runs')
      const row = db().query(
        `SELECT resource_kind, event_kind, resource_key FROM contention WHERE run_id=?`,
      ).get(live) as { resource_kind: string; event_kind: string; resource_key: string }
      expect(row).toEqual({ resource_kind: 'store', event_kind: 'invalidation', resource_key: String(live) })
    } finally {
      db().query(`UPDATE run SET status='ok' WHERE id=?`).run(live)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('land --status shows both sessions in the queue', () => {
    const { repo } = repoWithBranches(['status-a'])
    upsertProject({ name: 'landing-status-queue', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      db().query(
        `INSERT INTO landing (project, branch, status, session_id, started_at, requested_at, path_set)
         VALUES ('landing-status-queue', 'status-a', 'queued', 'session-one', ?, ?, '[]'),
                ('landing-status-queue', 'status-b', 'queued', 'session-two', ?, ?, '[]')`,
      ).run(
        new Date().toISOString(), new Date().toISOString(),
        new Date().toISOString(), new Date().toISOString(),
      )
      const text = landingStatus(repo)
      expect(text).toContain('session-one')
      expect(text).toContain('session-two')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
