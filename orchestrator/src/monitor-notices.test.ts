import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { MONITOR_CAPABILITY_PATH_ENV, MONITOR_CAPABILITY_TOKEN_ENV } from '../../shared/monitor-capability.ts'
import { addRun, allInjectChecks, claimMonitorNotices, markMonitorNoticesDelivered, db, deadRunningProcessConditions, dir, displayConditions, fileIssue, formatMonitorPass, hermeticGitEnv, monitor, monitorHistory, nowIso, parseFiledIssue, reconcileHub, rulingConditions, runWithDelayedStdoutReader, score, setDoc, upsertProject } from '../test/fixture.ts'

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const PROCESS_INSPECTION_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(
      ['/bin/ps', '-p', String(process.pid), '-o', 'command='],
      { stdout: 'ignore', stderr: 'ignore' },
    ).exitCode === 0
  } catch {
    return false
  }
})()

function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath,
    new URL('../../hub/src/cli.ts', import.meta.url).pathname, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}

function persistAddressedCondition(
  kind: string,
  subject: string,
  ownerSession: string,
  since = nowIso(),
): number {
  const invocation = (db().query(
    `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
     VALUES (?,?, 'backstop', 1, 0) RETURNING id`,
  ).get(since, since) as { id: number }).id
  return (db().query(
    `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
     VALUES (?,?,?,?,0,'recorded condition','reported',?) RETURNING id`,
  ).get(invocation, kind, subject, since, ownerSession) as { id: number }).id
}

describe('operational monitor record', () => {
  test('landing notices are read without consuming and acknowledged only for their owner', () => {
    const started = '2026-09-09T00:00:00.000Z'
    const finished = '2026-09-09T00:00:03.000Z'
    const landing = (db().query(
      `INSERT INTO landing (project,branch,status,session_id,started_at,finished_at)
       VALUES (?,?,?,?,?,?) RETURNING id`,
    ).get(PLATFORM_SLUG, 'DEV-438-notice', 'refused', 'landing-owner', started, finished) as { id: number }).id

    const first = claimMonitorNotices('landing-owner')
    expect(first).toEqual([expect.objectContaining({
      noticeId: `landing:${landing}`,
      kind: 'landing-refused',
      subject: `landing:${landing}`,
      ownerSession: 'landing-owner',
      detail: `LANDING-REFUSED ${landing}/DEV-438-notice 3.0s; inspect with 'orch land --status'`,
    })])
    expect(claimMonitorNotices('landing-owner')).toEqual(first)
    expect(claimMonitorNotices('somebody-else')).toEqual([])

    markMonitorNoticesDelivered('somebody-else', [`landing:${landing}`], '2026-09-09T00:01:00.000Z')
    expect(claimMonitorNotices('landing-owner')).toEqual(first)
    markMonitorNoticesDelivered('landing-owner', [`landing:${landing}`], '2026-09-09T00:02:00.000Z')
    expect(claimMonitorNotices('landing-owner')).toEqual([])
  })

  test('a condition acknowledgement cannot receipt a same-numbered landing terminalised after claim', () => {
    const nextId = (db().query(
      `SELECT MAX(id) + 1 id FROM (
         SELECT id FROM monitor_condition UNION ALL SELECT id FROM landing
       )`,
    ).get() as { id: number | null }).id ?? 1
    const started = '2026-09-09T01:00:00.000Z'
    db().query(
      `INSERT INTO landing (id,project,branch,status,session_id,started_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(nextId, PLATFORM_SLUG, 'DEV-438-collision', 'running', 'collision-owner', started)
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES (?,?,?,?,?) RETURNING id`,
    ).get(started, started, 'backstop', 1, 0) as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (id,invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(nextId, invocation, 'stale-run', 'run:collision', started, 1,
      'worker text', 'reported', 'collision-owner')

    const claimed = claimMonitorNotices('collision-owner')
    expect(claimed).toEqual([expect.objectContaining({ noticeId: `condition:${nextId}` })])
    db().query("UPDATE landing SET status='refused', finished_at=? WHERE id=?").run(nowIso(), nextId)
    markMonitorNoticesDelivered('collision-owner', claimed.map((notice) => notice.noticeId), nowIso())

    expect(db().query('SELECT heartbeat_delivered_at FROM landing WHERE id=?').get(nextId))
      .toEqual({ heartbeat_delivered_at: null })
    expect(claimMonitorNotices('collision-owner')).toEqual([
      expect.objectContaining({ noticeId: `landing:${nextId}`, kind: 'landing-refused' }),
    ])
  })

  test('monitor previews owned reclaim candidates and ignores review subjects', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-reclaim-')))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    const project = `monitor-reclaim-${repo.split('/').pop()}`
    upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })

    const treeRun = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    score(treeRun, 'full', 'right', 'faithful')
    const treeBranch = `technical/DEV-391-tree-${treeRun}`
    const tree = join(repo, '.claude', 'worktrees', `orch-${treeRun}`)
    git(repo, 'worktree', 'add', '-b', treeBranch, tree, 'main')
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='git' WHERE id=?`,
    ).run(tree, tree, treeBranch, treeBranch, base, treeRun)

    const branchRun = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    score(branchRun, 'full', 'right', 'faithful')
    const ownedBranch = `technical/DEV-391-owned-${branchRun}`
    git(repo, 'branch', ownedBranch, 'main')
    db().query('UPDATE run SET branch=?, minted_branch=? WHERE id=?')
      .run(ownedBranch, ownedBranch, branchRun)

    const reviewRun = addRun({ agent: 'codex', job: 'review-lens', status: 'ok', repo: project })
    score(reviewRun, 'full', 'right', 'faithful')
    const reviewSubject = 'technical/DEV-391-review-subject'
    git(repo, 'branch', reviewSubject, 'main')
    db().query('UPDATE run SET branch=?, minted_branch=NULL WHERE id=?')
      .run(reviewSubject, reviewRun)

    const priorCwd = process.cwd()
    try {
      process.chdir(repo)
      const result = await monitor('invoked')
      expect(result.conditions.some((row) => row.subject === `${project}:${reviewSubject}`)).toBe(false)
      const treeCondition = result.conditions.find((row) => row.subject === tree)
      expect(treeCondition, JSON.stringify(result.conditions, null, 2)).toBeDefined()
      expect(treeCondition?.action)
        .toContain(`would reclaim worktree ${tree}`)
      expect(result.conditions.find((row) => row.subject === `${project}:${ownedBranch}`)?.action)
        .toContain(`would reclaim branch ${project}:${ownedBranch}`)
      expect(result.conditions.filter((row) => row.action.startsWith('would reclaim'))).toHaveLength(2)
      expect(existsSync(tree)).toBe(true)
      expect(git(repo, 'show-ref', '--verify', `refs/heads/${ownedBranch}`)).not.toBe('')
    } finally {
      process.chdir(priorCwd)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('reports machine-wide while automatic reclaim is scoped to the invoked project', async () => {
    const local = mkdtempSync(join(tmpdir(), 'monitor-local-'))
    const foreign = mkdtempSync(join(tmpdir(), 'monitor-foreign-'))
    const localTree = join(local, '.claude', 'worktrees', 'orch-local')
    const foreignTree = join(foreign, '.claude', 'worktrees', 'orch-foreign')
    mkdirSync(localTree, { recursive: true })
    mkdirSync(foreignTree, { recursive: true })
    const localRoot = realpathSync(local)
    const foreignRoot = realpathSync(foreign)
    upsertProject({ name: 'monitor-local', path: localRoot, settings: { trunk: 'main' } })
    upsertProject({ name: 'monitor-foreign', path: foreignRoot, settings: { trunk: 'main' } })
    const priorCwd = process.cwd()
    try {
      process.chdir(localRoot)
      const result = await monitor('invoked')
      const localSubject = realpathSync(localTree)
      const foreignSubject = realpathSync(foreignTree)
      const localCondition = result.conditions.find((row) => row.subject === localSubject)
      const foreignCondition = result.conditions.find((row) => row.subject === foreignSubject)
      expect(localCondition?.action).toBe(
        `refused; worktree safety could not be proved: not a registered git worktree`,
      )
      expect(foreignCondition?.action).toBe(
        'reported; reclaim refused by monitor scope: monitor-foreign is outside invoked project monitor-local',
      )
      expect(result.conditions.filter((row) => row.action.includes('established verb'))).toHaveLength(0)
      expect(existsSync(localTree)).toBe(true)
      expect(existsSync(foreignTree)).toBe(true)
    } finally {
      process.chdir(priorCwd)
      rmSync(local, { recursive: true, force: true })
      rmSync(foreign, { recursive: true, force: true })
    }
  })

})
