import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRun, allocateLandingJournals, db, drainQueue, hermeticGitEnv, land, landingStatus,
  persistTerminalSnapshot, reconcileRun, setPostLandMigrateForFixture, upsertProject,
} from '../test/fixture.ts'
import { landingDescribeFixture } from '../test/fixture.ts'
import { applyMigrations, MIGRATIONS_FOLDER } from './migrations.ts'

describe('DEV-370 landing queue and branch ownership', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const { g, repoWithBranches, childLand, completedReview } = landingDescribeFixture()

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

  test('a conflicting merge-group member is refused and the remaining member lands on the next pick', () => {
    const { repo, trees } = repoWithBranches(['conflict-a', 'conflict-b'])
    for (const [branch, value] of [['conflict-a', 'a'], ['conflict-b', 'b']] as const) {
      writeFileSync(join(trees[branch]!, 'shared.txt'), `${value}\n`)
      g(trees[branch]!, 'add', 'shared.txt')
      g(trees[branch]!, 'commit', '-m', `shared ${value}`)
    }
    upsertProject({ name: 'landing-group-conflict', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      land(repo, 'conflict-a', { unreviewed: 'a', wait: false })
      land(repo, 'conflict-b', { unreviewed: 'b', wait: false })
      drainQueue(repo)
      const rows = db().query(
        `SELECT branch,status,claim_pid FROM landing WHERE project='landing-group-conflict' ORDER BY id`,
      ).all() as { branch: string; status: string; claim_pid: number | null }[]
      expect(rows).toEqual([
        { branch: 'conflict-a', status: 'landed', claim_pid: null },
        { branch: 'conflict-b', status: 'refused', claim_pid: null },
      ])
      expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('a\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a member advanced after enqueue is refused while the pinned peer lands', () => {
    const { repo, trees } = repoWithBranches(['advanced-a', 'advanced-b'])
    upsertProject({ name: 'landing-advanced-member', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const at = new Date().toISOString()
    const flags = JSON.stringify([{ name: '_flags', unreviewed: 'fixture' }])
    try {
      for (const branch of ['advanced-a', 'advanced-b']) {
        db().query(
          `INSERT INTO landing (project,branch,tip,status,started_at,requested_at,path_set,steps)
           VALUES ('landing-advanced-member',?,?,'queued',?,?,'[]',?)`,
        ).run(branch, g(repo, 'rev-parse', branch), at, at, flags)
      }
      writeFileSync(join(trees['advanced-a']!, 'later.txt'), 'later\n')
      g(trees['advanced-a']!, 'add', 'later.txt')
      g(trees['advanced-a']!, 'commit', '-m', 'advanced after enqueue')
      drainQueue(repo)
      expect(db().query(
        `SELECT branch,status FROM landing WHERE project='landing-advanced-member' ORDER BY id`,
      ).all()).toEqual([
        { branch: 'advanced-a', status: 'refused' },
        { branch: 'advanced-b', status: 'landed' },
      ])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a member whose review carry fails is dropped while an overridden peer lands', () => {
    const { repo, trees } = repoWithBranches(['carry-bad', 'carry-ok'])
    const project = 'landing-group-carry-fail'
    const reviewedTree = g(trees['carry-bad']!, 'rev-parse', 'HEAD^{tree}')
    completedReview(project, [reviewedTree], {
      branch: 'carry-bad', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees['carry-bad']!,
    })
    writeFileSync(join(trees['carry-bad']!, 'after-review.txt'), 'unreviewed\n')
    g(trees['carry-bad']!, 'add', 'after-review.txt')
    g(trees['carry-bad']!, 'commit', '-m', 'change after review')
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    const at = new Date().toISOString()
    try {
      for (const [branch, steps] of [
        ['carry-bad', JSON.stringify([{ name: '_flags' }])],
        ['carry-ok', JSON.stringify([{ name: '_flags', unreviewed: 'fixture' }])],
      ]) {
        db().query(
          `INSERT INTO landing (project,branch,tip,status,started_at,requested_at,path_set,steps)
           VALUES (?,?,?,'queued',?,?,'[]',?)`,
        ).run(project, branch, g(repo, 'rev-parse', branch), at, at, steps)
      }
      drainQueue(repo)
      expect(db().query(
        `SELECT branch,status FROM landing WHERE project=? ORDER BY id`,
      ).all(project)).toEqual([
        { branch: 'carry-bad', status: 'refused' },
        { branch: 'carry-ok', status: 'landed' },
      ])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('--unreviewed is scoped to one merge-group member', () => {
    const { repo, trees } = repoWithBranches(['override-one', 'reviewed-two'])
    const project = 'landing-group-member-flags'
    completedReview(project, [g(trees['reviewed-two']!, 'rev-parse', 'HEAD^{tree}')], {
      branch: 'reviewed-two', baseCommit: g(repo, 'rev-parse', 'main'), launchCwd: trees['reviewed-two']!,
    })
    upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
    const at = new Date().toISOString()
    try {
      for (const [branch, steps] of [
        ['override-one', JSON.stringify([{ name: '_flags', unreviewed: 'only this member' }])],
        ['reviewed-two', JSON.stringify([{ name: '_flags' }])],
      ]) {
        db().query(
          `INSERT INTO landing (project,branch,tip,status,started_at,requested_at,path_set,steps)
           VALUES (?,?,?,'queued',?,?,'[]',?)`,
        ).run(project, branch, g(repo, 'rev-parse', branch), at, at, steps)
      }
      drainQueue(repo)
      expect(db().query(
        `SELECT COUNT(*) n FROM landing_override WHERE project=?`,
      ).get(project)).toEqual({ n: 1 })
      expect(db().query(
        `SELECT branch,status FROM landing WHERE project=? ORDER BY id`,
      ).all(project)).toEqual([
        { branch: 'override-one', status: 'landed' },
        { branch: 'reviewed-two', status: 'landed' },
      ])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a merge group rebuilds on a moved trunk and lands after re-gating', () => {
    const { repo } = repoWithBranches(['move-group-a', 'move-group-b'])
    const gate = join(repo, 'move-group-gate.sh')
    writeFileSync(gate, `#!/bin/sh\nset -eu\nc='${repo}/gate-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\nif [ "$n" = 1 ]; then echo move > '${repo}/trunk-move.txt'; git -c core.hooksPath=/dev/null -C '${repo}' add trunk-move.txt; git -c core.hooksPath=/dev/null -C '${repo}' commit -m 'move trunk'; fi\n`)
    Bun.spawnSync(['chmod', '+x', gate])
    upsertProject({ name: 'landing-group-move', path: repo, settings: { trunk: 'main', gate } })
    try {
      land(repo, 'move-group-a', { unreviewed: 'a', wait: false })
      land(repo, 'move-group-b', { unreviewed: 'b', wait: false })
      drainQueue(repo)
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain('move-group-a.txt')
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain('move-group-b.txt')
      expect(readFileSync(join(repo, 'gate-count'), 'utf8')).toBe('2\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a single landing gets three gated attempts and refuses after a third trunk move', () => {
    for (const moves of [2, 3]) {
      const { repo } = repoWithBranches([`move-single-${moves}`])
      const gate = join(repo, 'move-single-gate.sh')
      writeFileSync(gate, `#!/bin/sh\nset -eu\nc='${repo}/gate-count'; n=0; [ ! -e "$c" ] || n=$(cat "$c"); n=$((n+1)); echo "$n" > "$c"\nif [ "$n" -le ${moves} ]; then echo "$n" > '${repo}/trunk-move.txt'; git -c core.hooksPath=/dev/null -C '${repo}' add trunk-move.txt; git -c core.hooksPath=/dev/null -C '${repo}' commit -m "move trunk $n"; fi\n`)
      Bun.spawnSync(['chmod', '+x', gate])
      upsertProject({ name: `landing-single-move-${moves}`, path: repo, settings: { trunk: 'main', gate } })
      try {
        if (moves === 2) {
          land(repo, `move-single-${moves}`, { unreviewed: 'moves' })
          expect(readFileSync(join(repo, 'gate-count'), 'utf8')).toBe('3\n')
        } else {
          expect(() => land(repo, `move-single-${moves}`, { unreviewed: 'moves' })).toThrow(
            'moved again',
          )
          expect(db().query(
            'SELECT status FROM landing WHERE project=? ORDER BY id DESC LIMIT 1',
          ).get(`landing-single-move-${moves}`)).toEqual({ status: 'refused' })
        }
      } finally { rmSync(repo, { recursive: true, force: true }) }
    }
  }, 15_000)

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
    const { repo } = repoWithBranches(['DEV-370-subject'])
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

    const unmintedId = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: 'landing-stop' })
    const unmintedRef = `orch/${unmintedId}`
    const unmintedTree = join(repo, 'trees', `orch-${unmintedId}`)
    g(repo, 'worktree', 'add', '-b', unmintedRef, unmintedTree, 'main')
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=NULL, worktree_source='git', session_id=? WHERE id=?`,
    ).run(unmintedTree, unmintedRef, 'landing-stop-session', unmintedId)
    const stopUnminted = Bun.spawnSync([process.execPath, CLI, 'stop', String(unmintedId)], {
      cwd: repo, env: {
        ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'landing-stop-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(stopUnminted.exitCode, stopUnminted.stderr.toString()).toBe(0)
    expect(stopUnminted.stdout.toString()).toContain(
      `branch ${unmintedRef} kept (review subject, not owned by run ${unmintedId})`,
    )
    expect(g(repo, 'rev-parse', unmintedRef)).toBeTruthy()
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

  test('the next drain refuses a landing claimed by a dead process', () => {
    const { repo } = repoWithBranches([])
    upsertProject({ name: 'landing-dead-claim', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const at = new Date().toISOString()
    try {
      db().query(
        `INSERT INTO landing (project,branch,status,session_id,started_at,requested_at,claim_pid,claim_session)
         VALUES ('landing-dead-claim','dead-branch','running','owner',?,?,2147483647,'dead-session')`,
      ).run(at, at)
      drainQueue(repo)
      const row = db().query(
        `SELECT status,error,claim_pid,claim_session FROM landing WHERE project='landing-dead-claim'`,
      ).get() as { status: string; error: string; claim_pid: number | null; claim_session: string | null }
      expect(row.status).toBe('refused')
      expect(row.error).toContain('dead pid 2147483647')
      expect(row.error).toContain('session dead-session')
      expect(row.error).toContain('orch land dead-branch')
      expect(row.claim_pid).toBeNull()
      expect(row.claim_session).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a live landing claim is waited on and the bounded wait names its owner and status command', () => {
    const { repo } = repoWithBranches([])
    upsertProject({ name: 'landing-live-claim', path: repo, settings: { trunk: 'main', gate: 'true' } })
    const at = new Date().toISOString()
    try {
      const row = db().query(
        `INSERT INTO landing (project,branch,status,session_id,started_at,requested_at,claim_pid,claim_session)
         VALUES ('landing-live-claim','live-branch','running','owner',?,?,?,?) RETURNING id`,
      ).get(at, at, process.pid, 'live-session') as { id: number }
      expect(() => drainQueue(repo, { untilId: row.id, timeoutMs: 80 })).toThrow(
        new RegExp(`timed out waiting for landing ${row.id}, claimed by pid ${process.pid}.*live-session.*orch land --status`),
      )
      expect(db().query('SELECT status FROM landing WHERE id=?').get(row.id)).toEqual({ status: 'running' })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  const writeJournal = (
    tree: string, folder: string,
    entries: { idx: number; tag: string; when: number }[],
  ) => {
    mkdirSync(join(tree, folder, 'meta'), { recursive: true })
    for (const entry of entries) {
      writeFileSync(join(tree, folder, `${entry.tag}.sql`), `-- ${entry.tag}\n`)
    }
    writeFileSync(join(tree, folder, 'meta', '_journal.json'), `${JSON.stringify({
      version: '7', dialect: 'sqlite',
      entries: entries.map((entry) => ({ ...entry, version: '6', breakpoints: true })),
    }, null, 2)}\n`)
  }

  test('landing rewrites an added journal entry to the next free idx and tag', () => {
    const { repo, trees } = repoWithBranches(['journal-remap'])
    const tree = trees['journal-remap']!
    writeJournal(tree, 'orchestrator/migrations', [
      { idx: 9, tag: '0009_provisional', when: 1788900000003 },
    ])
    g(tree, 'add', 'orchestrator/migrations')
    g(tree, 'commit', '-m', 'provisional journal')
    upsertProject({ name: 'landing-journal-remap', path: repo, settings: { trunk: 'main', gate: 'true' } })
    setPostLandMigrateForFixture({
      orchBin: '/usr/bin/true',
      hubBin: '/usr/bin/true',
    })
    try {
      land(repo, 'journal-remap', { unreviewed: 'journal-remap' })
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toContain(
        'orchestrator/migrations/0000_provisional.sql',
      )
      expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(
        'orchestrator/migrations/0009_provisional.sql',
      )
      const journal = JSON.parse(g(repo, 'show', 'main:orchestrator/migrations/meta/_journal.json')) as {
        entries: { idx: number; tag: string }[]
      }
      expect(journal.entries).toEqual([expect.objectContaining({ idx: 0, tag: '0000_provisional' })])
    } finally {
      setPostLandMigrateForFixture(null)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a concurrent journal collision is resolved and allocated above trunk', () => {
    const W = 1788900000004
    const { repo, trees } = repoWithBranches(['DEV-370-journal-concurrent'])
    const tree = trees['DEV-370-journal-concurrent']!
    writeJournal(repo, 'orchestrator/migrations', [{ idx: 10, tag: '0010_a', when: W }])
    g(repo, 'add', 'orchestrator/migrations')
    g(repo, 'commit', '-m', 'DEV-370 trunk journal')
    writeJournal(tree, 'orchestrator/migrations', [{ idx: 10, tag: '0010_b', when: W }])
    g(tree, 'add', 'orchestrator/migrations')
    g(tree, 'commit', '-m', 'DEV-370 branch journal')
    upsertProject({ name: 'landing-journal-concurrent', path: repo, settings: { trunk: 'main', gate: 'true' } })
    setPostLandMigrateForFixture({ orchBin: '/usr/bin/true', hubBin: '/usr/bin/true' })
    try {
      land(repo, 'DEV-370-journal-concurrent', { unreviewed: 'fixture' })
      const files = g(repo, 'ls-tree', '-r', '--name-only', 'main')
      expect(files).toContain('orchestrator/migrations/0011_b.sql')
      expect(files).not.toContain('orchestrator/migrations/0010_b.sql')
      const journal = JSON.parse(g(repo, 'show', 'main:orchestrator/migrations/meta/_journal.json')) as {
        entries: { idx: number; tag: string; when: number }[]
      }
      expect(journal.entries).toEqual([
        expect.objectContaining({ idx: 10, tag: '0010_a', when: W }),
        expect.objectContaining({ idx: 11, tag: '0011_b', when: W + 1 }),
      ])
      expect(g(repo, 'show', '-s', '--format=%s', 'main')).toBe('DEV-370 allocate journal at landing')
      expect(g(repo, 'show', '-s', '--format=%b', 'main')).toContain('Member task: DEV-370')

      const migrated = mkdtempSync(join(tmpdir(), 'landing-journal-apply-'))
      mkdirSync(join(migrated, 'meta'))
      const trunkEntries = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
        version: string; dialect: string; entries: { idx: number; tag: string; when: number }[]
      }
      for (const entry of trunkEntries.entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(migrated, `${entry.tag}.sql`))
      }
      // Sized from the real journal so a sibling branch landing another entry
      // does not break this assertion.
      const next = trunkEntries.entries.length
      const nextTag = `${String(next).padStart(4, '0')}_b`
      writeFileSync(join(migrated, `${nextTag}.sql`), `-- ${nextTag}\n`)
      writeFileSync(join(migrated, 'meta', '_journal.json'), JSON.stringify({
        version: trunkEntries.version,
        dialect: trunkEntries.dialect,
        entries: [...trunkEntries.entries, {
          idx: next, tag: nextTag, when: Math.max(W, trunkEntries.entries.at(-1)!.when) + 1,
          version: '6', breakpoints: true,
        }],
      }))
      const store = new Database(':memory:')
      expect(applyMigrations(store)).toHaveLength(next)
      expect(store.query('PRAGMA user_version').get()).toEqual({ user_version: next })
      expect(applyMigrations(store, migrated)).toEqual([nextTag])
      expect(store.query('PRAGMA user_version').get()).toEqual({ user_version: next + 1 })
      store.close()
      rmSync(migrated, { recursive: true, force: true })
    } finally {
      setPostLandMigrateForFixture(null)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('two branch journal entries are allocated in branch order with increasing when values', () => {
    const { repo, trees } = repoWithBranches(['DEV-370-journal-two'])
    const tree = trees['DEV-370-journal-two']!
    writeJournal(repo, 'orchestrator/migrations', [{ idx: 10, tag: '0010_a', when: 100 }])
    g(repo, 'add', 'orchestrator/migrations')
    g(repo, 'commit', '-m', 'DEV-370 trunk journal')
    writeJournal(tree, 'orchestrator/migrations', [
      { idx: 10, tag: '0010_b', when: 100 },
      { idx: 11, tag: '0011_c', when: 101 },
    ])
    g(tree, 'add', 'orchestrator/migrations')
    g(tree, 'commit', '-m', 'DEV-370 branch journals')
    upsertProject({ name: 'landing-journal-two', path: repo, settings: { trunk: 'main', gate: 'true' } })
    setPostLandMigrateForFixture({ orchBin: '/usr/bin/true', hubBin: '/usr/bin/true' })
    try {
      land(repo, 'DEV-370-journal-two', { unreviewed: 'fixture' })
      const journal = JSON.parse(g(repo, 'show', 'main:orchestrator/migrations/meta/_journal.json')) as {
        entries: { idx: number; tag: string; when: number }[]
      }
      expect(journal.entries.map(({ idx, tag, when }) => ({ idx, tag, when }))).toEqual([
        { idx: 10, tag: '0010_a', when: 100 },
        { idx: 11, tag: '0011_b', when: 101 },
        { idx: 12, tag: '0012_c', when: 102 },
      ])
    } finally {
      setPostLandMigrateForFixture(null)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('post-land migration invokes the registered main checkout binaries with a scrubbed environment', () => {
    const { repo, trees } = repoWithBranches(['main-binary-migrate'])
    const tree = trees['main-binary-migrate']!
    mkdirSync(join(tree, 'orchestrator', 'migrations'), { recursive: true })
    writeFileSync(join(tree, 'orchestrator', 'migrations', 'note.sql'), '-- journal\n')
    g(tree, 'add', 'orchestrator/migrations/note.sql')
    g(tree, 'commit', '-m', 'journal')
    mkdirSync(join(repo, 'bin'), { recursive: true })
    for (const name of ['orch', 'hub']) {
      writeFileSync(join(repo, 'bin', name), `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$PWD" "$1" "\${ORCH_DB-unset}" "\${ORCH_DEPTH-unset}" >> '${repo}/migrate-invocations'\necho ${name}-output\n`)
      Bun.spawnSync(['chmod', '+x', join(repo, 'bin', name)])
    }
    upsertProject({ name: 'landing-main-binary', path: repo, settings: { trunk: 'main', gate: 'true' } })
    try {
      land(repo, 'main-binary-migrate', { unreviewed: 'fixture' })
      expect(readFileSync(join(repo, 'migrate-invocations'), 'utf8')).toBe(
        `${repo}|migrate|unset|unset\n${repo}|migrate|unset|unset\n`,
      )
      const row = db().query(
        `SELECT steps FROM landing WHERE project='landing-main-binary'`,
      ).get() as { steps: string }
      expect(row.steps).toContain('orch-output')
      expect(row.steps).toContain('hub-output')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a hand-written idx that disagrees with the filename prefix is refused, naming both', () => {
    const { repo, trees } = repoWithBranches(['journal-disagree'])
    const tree = trees['journal-disagree']!
    writeJournal(tree, 'orchestrator/migrations', [
      { idx: 9, tag: '0008_wrong', when: 2 },
    ])
    g(tree, 'add', 'orchestrator/migrations')
    g(tree, 'commit', '-m', 'disagree')
    const from = g(repo, 'rev-parse', 'main')
    expect(() => allocateLandingJournals(tree, from)).toThrow(
      /hand-written idx 9 disagrees with filename prefix 8 \(0008_wrong\)/,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('a hand-written idx that collides with trunk\'s idx for the same tag is refused, naming both', () => {
    const { repo, trees } = repoWithBranches(['journal-collide'])
    writeJournal(repo, 'orchestrator/migrations', [
      { idx: 0, tag: '0000_base', when: 1 },
    ])
    g(repo, 'add', 'orchestrator/migrations')
    g(repo, 'commit', '-m', 'trunk journal')
    const tree = trees['journal-collide']!
    g(tree, 'merge', '--no-edit', '-m', 'sync', 'main')
    writeJournal(tree, 'orchestrator/migrations', [
      { idx: 5, tag: '0000_base', when: 1 },
    ])
    g(tree, 'add', 'orchestrator/migrations')
    g(tree, 'commit', '-m', 'colliding idx')
    const from = g(repo, 'rev-parse', 'main')
    expect(() => allocateLandingJournals(tree, from)).toThrow(
      /hand-written idx 5 collides with trunk's 0 for 0000_base/,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('journal loading refuses duplicate and unordered when values', () => {
    for (const [name, entries, message] of [
      ['duplicate', [{ idx: 0, tag: '0000_a', when: 2 }, { idx: 1, tag: '0001_b', when: 2 }], 'duplicate when 2'],
      ['unordered', [{ idx: 0, tag: '0000_a', when: 3 }, { idx: 1, tag: '0001_b', when: 2 }], 'unordered when 2 after 3'],
    ] as const) {
      const { repo, trees } = repoWithBranches([`journal-${name}`])
      const tree = trees[`journal-${name}`]!
      writeJournal(tree, 'orchestrator/migrations', [...entries])
      expect(() => allocateLandingJournals(tree, g(repo, 'rev-parse', 'main'))).toThrow(message)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('orch reconcile writes a terminal row from the persisted snapshot', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    persistTerminalSnapshot(id, {
      status: 'ok', error: null, failureKind: null, output: 'done',
      outputPath: '/tmp/out', promptPath: '/tmp/prompt',
      exitCode: 0, latencyMs: 12, vendorTokens: 3, vendorCostUsd: 0, model: 'codex',
      vendorSession: null, preConfinement: null,
      filesChanged: 1, changedPaths: '["a.ts"]', linesAdded: 2, linesRemoved: 0,
      testsRan: 1, testsPassed: 1, deviations: 0, escalations: 0,
    })
    db().query(`UPDATE run SET unreconciled=1, error='stale schema' WHERE id=?`).run(id)
    expect(reconcileRun(id)).toBe(`reconciled run ${id} as ok`)
    const row = db().query(
      `SELECT status, unreconciled, error, files_changed FROM run WHERE id=?`,
    ).get(id) as { status: string; unreconciled: number; error: string | null; files_changed: number | null }
    expect(row).toEqual({ status: 'ok', unreconciled: 0, error: null, files_changed: 1 })
  })
})
