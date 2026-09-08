import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { addRun, allInjectChecks, db, deadRunningProcessConditions, dir, fileIssue, hermeticGitEnv, monitor, monitorHistory, nowIso, parseFiledIssue, reconcileHub, rulingConditions, runWithDelayedStdoutReader, score, setDoc, upsertProject } from '../test/fixture.ts'

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath,
    new URL('../../hub/src/cli.ts', import.meta.url).pathname, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}

describe('operational monitor record', () => {
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
      expect(localCondition?.action).toBe(`refused; no run row records worktree ${localSubject}`)
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

  test('pipes a complete large human report before returning its condition status', async () => {
    const hubDb = join(dir, 'monitor-large-report-hub.db')
    const binDir = join(dir, 'monitor-large-report-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'docker'), 0o755)
    const prior = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
    ).get() as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(prior, 'detector-unavailable', 'tasks-waiting-on-ruling',
      '2026-09-04T00:00:00Z', 0, 'already filed', 'reported', 'DEV-test')
    let lastRunId = 0
    for (let i = 0; i < 750; i++) {
      lastRunId = addRun({
        agent: 'codex', job: 'implement', status: 'stale',
        startedAt: '2026-09-04T00:00:00Z',
      })
    }

    const cli = new URL('cli.ts', import.meta.url).pathname
    const human = await runWithDelayedStdoutReader([process.execPath, cli, 'monitor'], {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', HUB_DB: hubDb,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
    })
    const record = db().query(
      'SELECT * FROM monitor_invocation ORDER BY id DESC LIMIT 1',
    ).get() as any
    const conditions = db().query(
      'SELECT * FROM monitor_condition WHERE invocation_id=? ORDER BY id',
    ).all(record.id) as any[]
    const canonRows = allInjectChecks()
    const canonFindings = canonRows.reduce(
      (count, row) => count + row.findings.filter((finding) => finding.kind !== 'unchecked').length,
      0,
    )
    const canonDocs = canonRows.filter(
      (row) => row.findings.some((finding) => finding.kind !== 'unchecked'),
    ).length
    const lines = [
      `canon: ${canonFindings} stale references in ${canonDocs} docs`,
      `monitor ${record.id}: ${record.findings} condition(s), ${record.errors} observation error(s)`,
    ]
    for (const condition of conditions) {
      const old = condition.age_ms == null
        ? 'age unknown'
        : `${Math.round(condition.age_ms / 60_000)}m old`
      const sev = condition.severity ? `  ${condition.severity}` : ''
      lines.push(`  ${condition.kind}${sev}  ${condition.subject}  ${old}\n    ${condition.detail}\n    ${condition.action}${condition.issue_key ? `; ${condition.issue_key}` : ''}`)
    }
    const expected = Buffer.from(`${lines.join('\n')}\n`)
    expect(expected.byteLength).toBeGreaterThan(65_536)
    expect(human.stdout.byteLength).toBe(expected.byteLength)
    expect(human.stdout.equals(expected)).toBe(true)
    expect(human.stdout.toString()).toContain(`stale-run  run:${lastRunId} `)
    expect(human.exitCode).toBe(record.errors ? 1 : record.findings ? 2 : 0)
  })

  test('pipes a complete large monitor history JSON document', async () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
    ).get() as { id: number }).id
    const detail = 'history-detail-'.repeat(5_500)
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(invocation, 'stale-run', 'run:large-history', '2026-09-03T08:00:00Z', 57_600_000,
      detail, 'reported')

    const cli = new URL('cli.ts', import.meta.url).pathname
    const expected = Buffer.from(`${JSON.stringify(monitorHistory(20))}\n`)
    const run = await runWithDelayedStdoutReader(
      [process.execPath, cli, 'monitor', '--history', '--json'],
      { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
    )
    expect(expected.byteLength).toBeGreaterThan(65_536)
    expect(run.stdout.byteLength).toBe(expected.byteLength)
    expect(run.stdout.equals(expected)).toBe(true)
    expect(JSON.parse(run.stdout.toString())[0].conditions[0].detail).toBe(detail)
    expect(run.exitCode).toBe(0)
  })

  test('reports a running row whose agent process is gone with elapsed time and output size', () => {
    const clock = Date.parse('2026-09-04T20:00:10Z')
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running',
      startedAt: '2026-09-04T20:00:00Z' })
    // The live worker makes this a fixture the old worker-pid detector missed.
    db().query('UPDATE run SET pid=?, agent_pid=?, output_bytes=? WHERE id=?')
      .run(process.pid, 4_194_304, 53, id)

    expect(deadRunningProcessConditions(clock)).toEqual([expect.objectContaining({
      kind: 'dead-running-process', subject: `run:${id}`,
      since: '2026-09-04T20:00:00Z', ageMs: 10_000,
      detail: expect.stringContaining('worker pid'),
      action: 'reported; disposition and status repair require intent',
    })])
    const [condition] = deadRunningProcessConditions(clock)
    expect(condition!.detail).toContain('elapsed 10s')
    expect(condition!.detail).toContain('output 53 bytes')
    expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'running' })
  })

  test('records condition ages and reads them back by invocation', () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
    ).get() as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(invocation, 'stale-run', 'run:7', '2026-09-03T08:00:00Z', 57_600_000,
      'process is gone', 'reported')
    expect(monitorHistory(1)).toEqual([expect.objectContaining({
      id: invocation, trigger: 'backstop', findings: 1,
      conditions: [expect.objectContaining({ kind: 'stale-run', subject: 'run:7', age_ms: 57_600_000 })],
    })])
  })

  test('derives ghost interval ages from the audited hub reconcile command', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0,
      stdout: Buffer.from('closed:\n  interval 747618  orch:1205  starship/STAR-1  agent codex  run 1205 is terminal (ok); removes 19h engaged time\nleft open:\n  none\n'),
      stderr: Buffer.from(''), success: true } as any)
    try {
      const clock = Date.parse('2026-09-04T20:00:00Z')
      expect(reconcileHub(clock).conditions).toEqual([expect.objectContaining({
        kind: 'ghost-open-interval', subject: 'interval:747618', ageMs: 68_400_000,
        action: 'reconciled through hub reconcile',
      })])
    } finally { spawn.mockRestore() }
  })

  test('reports a task waiting past the rulings threshold and names the session', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        stale_after: '1h',
        questions: [
          { question_id: 11, task_key: 'DEV-215', session_id: 'sess-1', asked_at: '2026-09-04T18:00:00.000Z', age: 7_200_000 },
          { question_id: 12, task_key: 'DEV-1', session_id: 'sess-2', asked_at: '2026-09-04T19:30:00.000Z', age: 1_800_000 },
        ],
      })),
      stderr: Buffer.from(''), success: true } as any)
    try {
      const clock = Date.parse('2026-09-04T20:00:00.000Z')
      expect(rulingConditions(clock)).toEqual({
        conditions: [
          expect.objectContaining({
            kind: 'task-waiting-on-ruling', subject: 'question:12',
            severity: 'informational',
            since: '2026-09-04T19:30:00.000Z', ageMs: 1_800_000,
            detail: 'task DEV-1 waiting on a ruling; session sess-2; elapsed 30m',
            action: 'reported; it does not answer',
          }),
          expect.objectContaining({
            kind: 'task-waiting-on-ruling', subject: 'question:11',
            severity: 'attention',
            since: '2026-09-04T18:00:00.000Z', ageMs: 7_200_000,
            detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 2.0h',
            action: 'reported; it does not answer',
          }),
        ],
        errors: [],
      })
    } finally { spawn.mockRestore() }
  })

  test('two sessions stale on one task are two conditions and do not collide', async () => {
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({
          stale_after: '1h',
          questions: [
            { question_id: 101, task_key: 'DEV-1896', session_id: 'sess-D', asked_at: '2026-09-04T18:00:00.000Z', age: 7_200_000 },
            { question_id: 102, task_key: 'DEV-1896', session_id: 'sess-E', asked_at: '2026-09-04T18:10:00.000Z', age: 6_600_000 },
          ],
        })), stderr: Buffer.from(''), success: true }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const clock = Date.parse('2026-09-04T20:00:00.000Z')
      const result = await monitor('invoked', clock)
      expect(result.conditions.filter((c) => c.kind === 'task-waiting-on-ruling')).toEqual([
        expect.objectContaining({ subject: 'question:101', detail: expect.stringContaining('session sess-D') }),
        expect.objectContaining({ subject: 'question:102', detail: expect.stringContaining('session sess-E') }),
      ])
      expect(result.conditions.filter((c) => c.kind === 'task-waiting-on-ruling')
        .map((c) => c.detail)).toEqual([
        expect.stringContaining('task DEV-1896'),
        expect.stringContaining('task DEV-1896'),
      ])
    } finally { spawn.mockRestore() }
  })

  test('two untracked questions from one session are two conditions', async () => {
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({
          stale_after: '1h',
          questions: [
            { question_id: 201, task_key: null, session_id: 'sess-U', asked_at: '2026-09-04T18:00:00.000Z', age: 7_200_000 },
            { question_id: 202, task_key: null, session_id: 'sess-U', asked_at: '2026-09-04T18:05:00.000Z', age: 6_900_000 },
          ],
        })), stderr: Buffer.from(''), success: true }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const result = await monitor('invoked', Date.parse('2026-09-04T20:00:00.000Z'))
      expect(result.conditions.filter((c) => c.kind === 'task-waiting-on-ruling').map((c) => c.subject)
        .sort()).toEqual(['question:201', 'question:202'])
    } finally { spawn.mockRestore() }
  })

  test('one open question is one condition, escalated at the rulings threshold', async () => {
    const runId = addRun({
      agent: 'codex', job: 'implement', status: 'asking', session: 'sess-1',
      startedAt: '2026-09-04T19:30:00.000Z',
    })
    db().query('INSERT INTO question (id, run_id, asked_at, question) VALUES (?,?,?,?)')
      .run(2000, runId, '2026-09-04T19:30:00.000Z', 'which way?')
    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    const payload = (staleAfter: string) => JSON.stringify({
      stale_after: staleAfter,
      questions: [{
        question_id: 2000, task_key: 'DEV-215', session_id: 'sess-1',
        asked_at: '2026-09-04T19:30:00.000Z', age: 1_800_000,
      }],
    })
    const spawnFor = (staleAfter: string) => spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return { exitCode: 0, stdout: Buffer.from(payload(staleAfter)),
          stderr: Buffer.from(''), success: true }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    const related = (result: { conditions: { kind: string; subject: string }[] }) =>
      result.conditions.filter((c) =>
        c.kind === 'task-waiting-on-ruling' || c.kind === 'unanswered-question' ||
        c.kind === 'asking-run' || c.subject === 'question:2000' || c.subject === `run:${runId}`)

    const young = spawnFor('1h')
    try {
      const result = await monitor('invoked', clock)
      expect(related(result)).toEqual([expect.objectContaining({
        kind: 'task-waiting-on-ruling', subject: 'question:2000',
        severity: 'informational', ageMs: 1_800_000,
        detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 30m',
        action: 'reported; it does not answer',
      })])
    } finally { young.mockRestore() }

    const late = spawnFor('10m')
    try {
      const result = await monitor('invoked', clock)
      expect(related(result)).toEqual([expect.objectContaining({
        kind: 'task-waiting-on-ruling', subject: 'question:2000',
        severity: 'attention', ageMs: 1_800_000,
        detail: 'task DEV-215 waiting on a ruling; session sess-1; elapsed 30m',
        action: 'reported; it does not answer',
      })])
    } finally { late.mockRestore() }
  })

  test('an asking run with no open question is still asking-run', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'sess-recover' })
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
      const argv = cmd.map(String)
      if (argv.includes('rulings')) {
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ stale_after: '1h', questions: [] })),
          stderr: Buffer.from(''), success: true }
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      const result = await monitor('invoked')
      expect(result.conditions.filter((c) => c.kind === 'asking-run')).toEqual([
        expect.objectContaining({ subject: `run:${id}` }),
      ])
      expect(result.conditions.some((c) => c.kind === 'task-waiting-on-ruling')).toBe(false)
      expect(result.conditions.some((c) => c.kind === 'unanswered-question')).toBe(false)
    } finally { spawn.mockRestore() }
  })

  test('a missing hub rulings document is an observation error, not emptiness', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 1,
      stdout: Buffer.from(''), stderr: Buffer.from('hub database is absent at /tmp/none'),
      success: false } as any)
    try {
      expect(rulingConditions()).toEqual({
        conditions: [],
        errors: ['hub database is absent at /tmp/none'],
      })
    } finally { spawn.mockRestore() }
  })

  test('files monitor provenance against a real invocation without a fake session', async () => {
    const hubDb = join(dir, 'monitor-file-issue.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    delete process.env.CLAUDE_CODE_SESSION_ID
    upsertProject({ name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] } })
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,trigger) VALUES (?, 'backstop') RETURNING id`,
    ).get(nowIso()) as { id: number }).id
    try {
      const filed = await fileIssue({ kind: 'defect', what_happened: 'A detector is unavailable',
        expected: 'The detector has machine-readable state', reproduce_command: 'orch monitor',
        environment: 'test monitor pass', evidence: `monitor invocation ${invocation}`,
        not_established: 'The state contract is not designed',
      }, { kind: 'monitor', invocationId: invocation, affectedProject: 'starship' }, PLATFORM_SLUG)
      expect(filed).toMatchObject({
        reporter: 'monitor', reporter_id: invocation,
        monitor_invocation_id: invocation, session: null, project: PLATFORM_SLUG,
      })
      expect(Object.keys(filed).sort()).toEqual([
        'duplicates', 'key', 'kind', 'monitor_invocation_id', 'project', 'reporter',
        'reporter_id', 'session', 'title', 'title_shortened', 'worker_run_id',
      ])
      const shown = Bun.spawnSync([new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', filed.key, '--json'], { env: { ...process.env }, stdout: 'pipe' })
      const task = JSON.parse(shown.stdout.toString()).task
      expect(task.body).toStartWith('FILED ISSUE DATA: {')
      expect(task.body).toContain('REPORTER KIND: MONITOR')
      expect(task.body).toContain(`REPORTING MONITOR INVOCATION: ${invocation}`)
      expect(task.body).toContain('AFFECTED PROJECT: starship')
      expect(task.body).not.toContain('REPORTING SESSION:')
      expect(parseFiledIssue({ task })).toMatchObject({
        kind: 'defect', reportingProject: PLATFORM_SLUG,
        whatHappened: 'A detector is unavailable',
        expected: 'The detector has machine-readable state',
        reproduceCommand: 'orch monitor', environment: 'test monitor pass',
        evidence: `monitor invocation ${invocation}`,
        notEstablished: 'The state contract is not designed',
      })
    } finally {
      rmSync(hubDb, { force: true }); rmSync(`${hubDb}-shm`, { force: true }); rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })
})

describe('session-brief hook lists open resumes without injecting bodies', () => {
  const hook = new URL('../hooks/session-brief.py', import.meta.url).pathname
  const heartbeat = new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname
  const bypassOversizeWriteGate = () => {
    const doc = setDoc({
      scope: 'global', subject: null, slug: 'oversize', title: 'Oversize',
      body: 'x'.repeat(70 * 1024), delivery: 'demand',
    })
    db().query("UPDATE doc SET delivery='inject' WHERE id=?").run(doc.id)
  }
  const runBrief = (
    payload: object,
    extraEnv: Record<string, string> = {},
    colour: 'plain' | 'ansi' = 'plain',
  ) => {
    const {
      CLAUDE_CODE_SESSION_ID: _drop,
      FORCE_COLOR: _forceColor,
      NO_COLOR: _noColor,
      ...rest
    } = process.env
    const colourEnv = colour === 'ansi' ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' }
    return Bun.spawnSync(
      ['python3', hook],
      {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe', stderr: 'pipe',
        env: { ...rest, ORCH_DB: process.env.ORCH_DB!, ...extraEnv, ...colourEnv },
      },
    )
  }
  const hookOutput = (p: ReturnType<typeof runBrief>) => JSON.parse(p.stdout.toString()) as {
    hookSpecificOutput: { hookEventName: string, additionalContext: string }
    systemMessage?: string
  }
  const resumeBody = (status: string, written: string) =>
    `---\nstatus: ${status}\nepic: demo\nproject: known\nwritten: ${written}\n---\n\nSECRET BODY\nNEXT ACTION\n`
  const runWithResumePayload = (resumePayload: string) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-resume-payload-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      `#!/bin/sh
if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then echo "OPERATOR BRIEF"; exit 0; fi
if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then printf '%s\\n' '${resumePayload}'; exit 0; fi
if [ "$1" = "inbox" ]; then echo '[{"session_liveness":"live","can_answer":true}]'; exit 0; fi
exit 1
`,
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      return { process: p, output: hookOutput(p) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const runWithResumeCommand = (resumeCommand: string) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-resume-command-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      `#!/bin/sh
if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then echo "OPERATOR BRIEF"; exit 0; fi
if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then ${resumeCommand}; fi
if [ "$1" = "inbox" ]; then echo '[{"session_liveness":"live","can_answer":true}]'; exit 0; fi
exit 1
`,
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      return { process: p, output: hookOutput(p) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('prints nothing on compact, clear and fork when there are no open briefs', () => {
    for (const source of ['compact', 'clear', 'fork']) {
      const p = runBrief({ cwd: '/w/known', source, session_id: 'sid-compact' })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toBe('')
      expect(p.stderr.toString()).toBe('')
    }
  })

  test('startup and resume with no briefs hand over the heartbeat arm command', () => {
    for (const source of ['startup', 'resume']) {
      const p = runBrief({ cwd: '/w/known', source, session_id: 'sid-arm' })
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toBe('')
      const out = hookOutput(p)
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
      expect(out.hookSpecificOutput.additionalContext).toBe(
        `Arm under Monitor from the main checkout: ${heartbeat} sid-arm\n`,
      )
      expect(out.systemMessage).toBeUndefined()
    }
  })

  test('a refused operator brief is fail-open and visible in systemMessage', () => {
    bypassOversizeWriteGate()
    const p = runBrief({ cwd: dir, source: 'startup', session_id: 'sid-budget' })
    expect(p.exitCode).toBe(0)
    const out = hookOutput(p)
    expect(out.systemMessage).toStartWith('operator brief refused: canon pack is ')
    expect(out.systemMessage).not.toContain('\x1b[')
    expect(out.hookSpecificOutput.additionalContext).toContain('Arm under Monitor from the main checkout:')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('x'.repeat(100))
  })

  test('a refused operator brief preserves the coloured CLI error in systemMessage', () => {
    bypassOversizeWriteGate()
    const p = runBrief(
      { cwd: dir, source: 'startup', session_id: 'sid-budget' },
      {},
      'ansi',
    )
    expect(p.exitCode).toBe(0)
    expect(hookOutput(p).systemMessage).toMatch(
      /^operator brief refused: \x1b\[0m\x1b\[31mcanon pack is \d+ bytes; budget is 65536 bytes$/,
    )
  })

  test('an old last-seen value is reported as unknown, never orphaned', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('quiet-owner', id)
    db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?,?)')
      .run('quiet-owner', '2026-09-01T00:00:00.000Z')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'quiet decision?')

    const p = runBrief({ cwd: '/w/known', source: 'compact', session_id: 'reader' })
    expect(p.exitCode).toBe(0)
    const out = hookOutput(p)
    expect(out.systemMessage).toBe(
      '1 other-session question visible; only their owners may rule. ' +
      '1 visible question has unknown owner liveness.',
    )
    expect(out.systemMessage).not.toContain('orphaned')
    expect(out.systemMessage).not.toContain('waiting on your ruling')
  })

  test('machine-wide questions distinguish this session rulings from foreign visibility', () => {
    const own = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const foreign = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('brief-owner', own)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('other-owner', foreign)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(own, new Date().toISOString(), 'own decision?')
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(foreign, new Date().toISOString(), 'foreign decision?')

    const p = runBrief({ cwd: '/w/known', source: 'compact', session_id: 'brief-owner' })
    expect(p.exitCode).toBe(0)
    const out = hookOutput(p)
    expect(out.systemMessage).toContain('1 question waiting on your ruling.')
    expect(out.systemMessage).toContain(
      '1 other-session question visible; only their owners may rule.',
    )
  })

  test('a successful malformed inbox response reports unknown state, not zero questions', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-invalid-inbox-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      '#!/bin/sh\nif [ "$1" = "inbox" ]; then echo "not-json"; else echo \'{"open":[],"unreadable":[]}\'; fi\nexit 0\n',
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(JSON.parse(p.stdout.toString()).systemMessage).toBe(
        'Inbox response was invalid; question state is unknown.',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed inbox command reports unknown state, not zero questions', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-failed-inbox-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      '#!/bin/sh\nif [ "$1" = "inbox" ]; then exit 7; else echo \'{"open":[],"unreadable":[]}\'; fi\nexit 0\n',
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(JSON.parse(p.stdout.toString()).systemMessage).toBe(
        'Inbox command failed with exit 7; question state is unknown.',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an inbox timeout reports unknown state, not zero questions', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-timeout-inbox-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      '#!/bin/sh\nif [ "$1" = "inbox" ]; then exec sleep 20; else echo \'{"open":[],"unreadable":[]}\'; fi\nexit 0\n',
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(JSON.parse(p.stdout.toString()).systemMessage).toBe(
        'Inbox observation timed out; question state is unknown.',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('a missing orch executable reports unknown question state', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-missing-orch-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(JSON.parse(p.stdout.toString()).systemMessage).toContain(
        'Inbox command is missing or not executable:',
      )
      expect(JSON.parse(p.stdout.toString()).systemMessage).toContain(
        'question state is unknown.',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports unreadable resume briefs without offering them as resumable', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'unreadable', title: 'Unreadable',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run('BODY without frontmatter', 'resume', 'known', 'unreadable')

    const result = runBrief({ cwd: '/w/known', source: 'clear' })
    expect(result.exitCode).toBe(0)
    const output = hookOutput(result)
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'UNREADABLE RESUME BRIEF `unreadable`: no-frontmatter.',
    )
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Offer to resume')
    expect(output.systemMessage).toContain('Unreadable resume brief: `unreadable`.')
    expect(output.systemMessage).not.toContain('Open resume brief')
  })

  test('accepts an unrecognised-status unreadable item and still emits the other hook sections', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[],"unreadable":[{"slug":"pending-brief","reason":"unrecognised-status"}]}',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'UNREADABLE RESUME BRIEF `pending-brief`: unrecognised-status.',
    )
    expect(output.systemMessage).toContain('Unreadable resume brief: `pending-brief`.')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).not.toContain('Resume response was invalid')
    expect(output.systemMessage).not.toContain('Open resume brief')
  })

  test('malformed stdin exits zero and prints nothing', () => {
    const p = Bun.spawnSync(['python3', hook], {
      stdin: new TextEncoder().encode('{not json'),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
  })

  test('rejects a whitespace-containing resume slug without blanking other hook output', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[{"slug":"hello world","title":"T","age":"1d"}],"unreadable":[]}',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(output.systemMessage).not.toContain('`hello`')
  })

  test('rejects an all-whitespace resume slug instead of treating its title as the slug', () => {
    const { output } = runWithResumePayload(
      '{"open":[{"slug":"   ","title":"forged-brief","age":"1d"}],"unreadable":[]}',
    )
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(output.systemMessage).not.toContain('`forged-brief`')
  })

  test('rejects an empty resume slug without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[{"slug":"","title":"","age":""}],"unreadable":[]}',
    )
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).not.toBe('')
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
  })

  test('enforces the document slug contract on resume payloads', () => {
    const outside = runWithResumePayload(
      '{"open":[{"slug":"../outside","title":"T","age":"1d"}],"unreadable":[]}',
    ).output
    expect(outside.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(outside.systemMessage).not.toContain('`../outside`')

    const valid = runWithResumePayload(
      '{"open":[{"slug":"a-valid-slug","title":"T","age":"1d"}],"unreadable":[]}',
    ).output
    expect(valid.systemMessage).toContain('Open resume brief: `a-valid-slug`.')
    expect(valid.systemMessage).not.toContain('Resume response was invalid')

    const tooLong = 'a'.repeat(65)
    const overLimit = runWithResumePayload(JSON.stringify({
      open: [{ slug: tooLong, title: 'T', age: '1d' }], unreadable: [],
    })).output
    expect(overLimit.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(overLimit.systemMessage).not.toContain(`\`${tooLong}\``)
  })

  test('a failed resume command is visible without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumeCommand(
      'echo "first failure" >&2; echo "second failure" >&2; exit 7',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain(
      'Resume command failed with exit 7: first failure; brief state is unknown.',
    )
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
  })

  test('a resume timeout is visible without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumeCommand('exec sleep 20')
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain(
      'Resume observation timed out; brief state is unknown.',
    )
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
  }, 15_000)

  for (const [name, payload] of [
    ['null unreadable', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}],"unreadable":null}'],
    ['missing unreadable', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}]}'],
    ['invalid unreadable item', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}],"unreadable":[{"slug":"x","reason":"unknown"}]}'],
  ]) {
    test(`keeps a valid open brief and reports ${name}`, () => {
      const { output } = runWithResumePayload(payload)
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'Open resume brief `epic-name`.',
      )
      expect(output.systemMessage).toContain('Open resume brief: `epic-name`.')
      expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    })
  }

  test('one open brief: cold start asks, continuation offers, never dumps the body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const listLine = `${'epic-name'.padEnd(24)} ${'Title here'.padEnd(24)}`
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(cold.exitCode).toBe(0)
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const coldOut = coldOutput.hookSpecificOutput.additionalContext
    expect(coldOut).toContain(listLine)
    expect(coldOut).toContain(
      'Open resume brief `epic-name`. Ask whether to load it before fetching with get_doc; after they agree and it is loaded, run orch doc consume.',
    )
    expect(coldOut).not.toContain('SECRET BODY')
    expect(coldOutput.systemMessage).toBe('Open resume brief: `epic-name`.')
    const cont = runBrief({ cwd: '/w/known', source: 'clear' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume brief `epic-name`. Offer to resume from it; fetch with get_doc only after they agree, then run orch doc consume.',
    )
    const resumeSrc = runBrief({ cwd: '/w/known', source: 'resume' })
    expect(hookOutput(resumeSrc).hookSpecificOutput.additionalContext).toContain('Ask whether to load it')
    const fork = runBrief({ cwd: '/w/known', source: 'fork' })
    expect(hookOutput(fork).hookSpecificOutput.additionalContext).toContain('Offer to resume from it')
  })

  test('several open briefs use the plural sentence', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'one', title: 'First',
      body: resumeBody('open', '2026-09-03T01:00:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'two', title: 'Second',
      body: resumeBody('open', '2026-09-03T02:00:00.000Z'),
    })
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Ask which (if any) to load before fetching with get_doc; after they agree and one is loaded, run orch doc consume.',
    )
    expect(coldOutput.systemMessage).toBe('Open resume briefs: `two`, `one`.')
    const cont = runBrief({ cwd: '/w/known', source: 'compact' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Offer to resume from one of them; fetch with get_doc only after they agree, then run orch doc consume.',
    )
  })

  test('keeps the operator brief and appends resumes after it', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    const out = hookOutput(p).hookSpecificOutput.additionalContext
    expect(out).toContain('## Global\n\nG')
    expect(out.indexOf('## Global')).toBeLessThan(out.indexOf('epic-name'))
    expect(out).toContain('Ask whether to load it')
  })

  test('startup with the script present and no session id prints nothing', () => {
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
    expect(p.stderr.toString()).toBe('')
  })

  test('payload session_id wins over CLAUDE_CODE_SESSION_ID', () => {
    const p = runBrief(
      { cwd: '/w/known', source: 'startup', session_id: 'from-payload' },
      { CLAUDE_CODE_SESSION_ID: 'from-env' },
    )
    expect(hookOutput(p).hookSpecificOutput.additionalContext).toBe(
      `Arm under Monitor from the main checkout: ${heartbeat} from-payload\n`,
    )
  })

  test('falls back to CLAUDE_CODE_SESSION_ID when the payload has no session_id', () => {
    const p = runBrief(
      { cwd: '/w/known', source: 'startup' },
      { CLAUDE_CODE_SESSION_ID: 'from-env' },
    )
    expect(hookOutput(p).hookSpecificOutput.additionalContext).toBe(
      `Arm under Monitor from the main checkout: ${heartbeat} from-env\n`,
    )
  })

  const runCopiedBrief = (opts: { payload: object, heartbeat: 'missing' | 'non-executable' }) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-heartbeat-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    writeFileSync(
      join(root, 'bin', 'orch'),
      '#!/bin/sh\n' +
      'if [ "$1" = "inbox" ]; then echo "[]"; exit 0; fi\n' +
      'if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then echo \'{"open":[],"unreadable":[]}\'; exit 0; fi\n' +
      'if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then exit 0; fi\n' +
      'exit 1\n',
    )
    chmodSync(join(root, 'bin', 'orch'), 0o755)
    const copiedHeartbeat = join(hooksDir, 'orch-heartbeat.sh')
    if (opts.heartbeat === 'non-executable') {
      writeFileSync(copiedHeartbeat, '#!/bin/sh\nexit 0\n')
      chmodSync(copiedHeartbeat, 0o644)
    }
    const { CLAUDE_CODE_SESSION_ID: _drop, ...rest } = process.env
    const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
      stdin: new TextEncoder().encode(JSON.stringify(opts.payload)),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...rest, ORCH_DB: process.env.ORCH_DB! },
    })
    return { p, heartbeat: copiedHeartbeat, root }
  }

  test('missing heartbeat is a notice on both channels, not a block', () => {
    const { p, heartbeat: missingPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup', session_id: 'sid-missing' },
      heartbeat: 'missing',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${missingPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-executable heartbeat is a notice on both channels, not a block', () => {
    const { p, heartbeat: blockedPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup', session_id: 'sid-nox' },
      heartbeat: 'non-executable',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${blockedPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing heartbeat still notices when session id is absent', () => {
    const { p, heartbeat: missingPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup' },
      heartbeat: 'missing',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${missingPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('architect heartbeat session scope', () => {
  const heartbeat = new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname

  const fixture = (orchBody: string) => {
    const root = mkdtempSync(join(tmpdir(), 'heartbeat-fixture-'))
    const hooks = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooks, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    const copiedHeartbeat = join(hooks, 'orch-heartbeat.sh')
    copyFileSync(heartbeat, copiedHeartbeat)
    chmodSync(copiedHeartbeat, 0o755)
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(fakeOrch, orchBody)
    chmodSync(fakeOrch, 0o755)
    return { root, heartbeat: copiedHeartbeat }
  }

  test('the explicit SID overrides the inherited session and uses the machine-wide inbox', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  if [ "$2" != "--all" ] || [ "$3" != "--json" ]; then exit 19; fi
  if [ "$CLAUDE_CODE_SESSION_ID" = "payload-owner" ]; then
    echo '[{"can_answer":true}]'
  else
    echo '[{"can_answer":false}]'
  fi
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"payload-owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`)
    try {
      const p = Bun.spawnSync([f.heartbeat, 'payload-owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe',
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: 'environment-owner',
        },
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('BLOCKED - 1 question(s) waiting on you')
      expect(p.stdout.toString()).not.toContain('nothing needed from you')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('malformed inbox or run observations report degraded, never zero', () => {
    for (const malformed of ['inbox', 'runs', 'empty-runs']) {
      const inbox = malformed === 'inbox' ? 'not-json' : '[]'
      const runs = malformed === 'runs'
        ? 'not-json'
        : malformed === 'empty-runs'
          ? ''
        : '{"id":7,"job":"implement","agent":"codex","status":"ok","session_id":"other","started_at":"2026-09-05T00:00:00.000Z"}'
      const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '${inbox}'
elif [ "$1" = "runs" ]; then
  echo '${runs}'
else
  exit 20
fi
`)
      try {
        const p = Bun.spawnSync([f.heartbeat, 'payload-owner', '0', '1'], {
          stdout: 'pipe', stderr: 'pipe',
          env: process.env,
        })
        expect(p.exitCode).toBe(0)
        expect(p.stdout.toString()).toContain('DEGRADED - orch observation failed')
        expect(p.stdout.toString()).toContain('State unknown; NOT concluding clear')
        expect(p.stdout.toString()).not.toContain('nothing needed from you')
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    }
  })

  test('a degraded tick keeps the last orch stderr line', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo 'store is locked by pid 99' >&2
  exit 1
fi
echo '{"id":1,"job":"implement","agent":"codex","status":"running","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
`)
    try {
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('DEGRADED - orch observation failed')
      expect(p.stdout.toString()).toContain('last stderr: store is locked by pid 99')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('WAITING names idle when the last event is older than the warn threshold', () => {
    const live = addRun({ agent: 'grok', job: 'implement', status: 'running', session: 'heartbeat-idle' })
    db().query('UPDATE run SET last_event_at=?, latency_ms=NULL WHERE id=?')
      .run(new Date(Date.now() - 12 * 60_000).toISOString(), live)
    const p = Bun.spawnSync([heartbeat, 'heartbeat-idle', '0', '1'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    expect(p.stdout.toString()).toContain('WAITING')
    expect(p.stdout.toString()).toContain(` ${live}/implement grok running`)
    expect(p.stdout.toString()).toContain('idle 12m')
  })

  test('first-sight terminal runs report once, with harness failures distinguished', () => {
    const harness = addRun({ agent: 'codex', job: 'implement', status: 'failed', latency: 1500 })
    const failed = addRun({ agent: 'grok', job: 'fix', status: 'failed', latency: 1500 })
    const live = addRun({ agent: 'agy', job: 'craft', status: 'running' })
    db().query("UPDATE run SET session_id='heartbeat-owner', failure_kind='harness', error='caller HEAD behind base' WHERE id=?").run(harness)
    db().query("UPDATE run SET session_id='heartbeat-owner', failure_kind='other', error='agent failed' WHERE id=?").run(failed)
    db().query("UPDATE run SET session_id='heartbeat-owner', latency_ms=NULL WHERE id=?").run(live)

    const p = Bun.spawnSync([heartbeat, 'heartbeat-owner', '0', '2'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    expect(p.exitCode).toBe(0)
    const out = p.stdout.toString()
    expect(out).toContain(`HARNESS-REFUSED ${harness}/implement codex harness 1.5s caller HEAD behind base`)
    expect(out).toContain(`FAILED ${failed}/fix grok other 1.5s agent failed`)
    expect(out.indexOf(`HARNESS-REFUSED ${harness}/implement`)).toBe(out.lastIndexOf(`HARNESS-REFUSED ${harness}/implement`))
    expect(out.indexOf(`FAILED ${failed}/fix`)).toBe(out.lastIndexOf(`FAILED ${failed}/fix`))
  })

  test('first sight seeds old terminal runs silently and reports only recent ones', () => {
    const now = Date.now()
    const old = addRun({
      agent: 'codex', job: 'implement', status: 'failed', latency: 1500,
      startedAt: new Date(now - 60 * 60_000 - 1500).toISOString(),
    })
    const recent = addRun({
      agent: 'grok', job: 'fix', status: 'failed', latency: 1500,
      startedAt: new Date(now - 30_000 - 1500).toISOString(),
    })
    const live = addRun({ agent: 'agy', job: 'craft', status: 'running' })
    for (const id of [old, recent]) {
      db().query("UPDATE run SET session_id='heartbeat-recency', failure_kind='other', error='agent failed' WHERE id=?").run(id)
    }
    db().query("UPDATE run SET session_id='heartbeat-recency', latency_ms=NULL WHERE id=?").run(live)

    const p = Bun.spawnSync([heartbeat, 'heartbeat-recency', '0', '2'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    expect(p.exitCode).toBe(0)
    const out = p.stdout.toString()
    expect(out).not.toContain(`FAILED ${old}/implement`)
    expect(out.match(new RegExp(`FAILED ${recent}/fix`, 'g'))).toHaveLength(1)
  })

  test('terminal recency and duration come from the last turn of a resumed chain', () => {
    const now = Date.now()
    const oldRoot = addRun({
      agent: 'codex', job: 'implement', status: 'asking', latency: 60 * 60_000,
      startedAt: new Date(now - 2 * 60 * 60_000).toISOString(), session: 'heartbeat-turns',
    })
    addRun({
      agent: 'codex', job: 'implement', status: 'failed', latency: 1500,
      startedAt: new Date(now - 30_000 - 1500).toISOString(), parent: oldRoot, turn: 2,
      kind: 'other',
    })
    const recentRoot = addRun({
      agent: 'grok', job: 'fix', status: 'asking', latency: 1000,
      startedAt: new Date(now - 30_000).toISOString(), session: 'heartbeat-turns',
    })
    addRun({
      agent: 'grok', job: 'fix', status: 'failed', latency: 1500,
      startedAt: new Date(now - 60 * 60_000 - 1500).toISOString(), parent: recentRoot, turn: 2,
      kind: 'other',
    })
    const live = addRun({
      agent: 'agy', job: 'craft', status: 'running', session: 'heartbeat-turns',
    })
    db().query("UPDATE run SET error='child failed' WHERE parent_run_id IN (?,?)").run(oldRoot, recentRoot)
    db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(live)

    const p = Bun.spawnSync([heartbeat, 'heartbeat-turns', '0', '2'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    expect(p.exitCode).toBe(0)
    const out = p.stdout.toString()
    expect(out.match(new RegExp(`FAILED ${oldRoot}/implement codex other 1\\.5s child failed`, 'g'))).toHaveLength(1)
    expect(out).not.toContain(`FAILED ${recentRoot}/fix`)
  })

  test('a run that finishes between ticks reports FINISHED once', async () => {
    const finishing = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const live = addRun({ agent: 'agy', job: 'craft', status: 'running' })
    for (const id of [finishing, live]) {
      db().query("UPDATE run SET session_id='heartbeat-finisher', latency_ms=NULL WHERE id=?").run(id)
    }
    const p = Bun.spawn([heartbeat, 'heartbeat-finisher', '0', '3'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    const reader = p.stdout.getReader()
    const decoder = new TextDecoder()
    let out = ''
    while (!out.includes('WAITING')) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += decoder.decode(chunk.value, { stream: true })
    }
    expect(out).toContain('WAITING')
    db().query("UPDATE run SET status='ok', latency_ms=2300 WHERE id=?").run(finishing)
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += decoder.decode(chunk.value, { stream: true })
    }
    out += decoder.decode()
    expect(await p.exited).toBe(0)
    expect(out.match(new RegExp(`FINISHED ${finishing}/implement codex 2\\.3s`, 'g'))).toHaveLength(1)
  })

  test('uses the absolute sibling orch and reports removal of its pinned launch directory', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  root=$(cd "$(dirname "$0")/.." && pwd)
  echo '[]'
  rm -rf "$root"
  exit 0
fi
exit 20
`)
    const decoy = mkdtempSync(join(tmpdir(), 'heartbeat-path-decoy-'))
    writeFileSync(join(decoy, 'orch'), '#!/bin/sh\necho PATH_ORCH_USED\nexit 0\n')
    chmodSync(join(decoy, 'orch'), 0o755)
    const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '2'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PATH: `${decoy}:${process.env.PATH ?? ''}` },
    })
    try {
      expect(p.exitCode).toBe(2)
      expect(p.stdout.toString()).toBe(
        'DEGRADED: launch directory removed; re-arm from the main checkout\n',
      )
      expect(p.stdout.toString()).not.toContain('PATH_ORCH_USED')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
      rmSync(decoy, { recursive: true, force: true })
    }
  })
})
