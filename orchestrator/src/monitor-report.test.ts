import { describe,expect,spyOn,test } from 'bun:test'
import { chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { addRun,db,dir,displayConditions,hermeticGitEnv,monitor,monitorHistory,upsertProject } from '../test/fixture.ts'
import './monitor-report.test-residue.ts'

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

describe('operational monitor reports', () => {
  test('marks the human condition list partial when an observation fails', async () => {
    const hubDb = join(dir, 'monitor-partial-hub.db')
    const binDir = join(dir, 'monitor-partial-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\necho inventory-offline >&2\nexit 17\n')
    chmodSync(join(binDir, 'docker'), 0o755)
    migrateHub(hubDb)
    const priorHub = process.env.HUB_DB
    const docker = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[]) => {
      if (argv[0] === 'docker' && argv[1] === 'volume') return {
        exitCode: 17, stdout: Buffer.from(''), stderr: Buffer.from('inventory-offline'), success: false,
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
    }) as unknown as typeof Bun.spawnSync)
    try {
      process.env.HUB_DB = hubDb
      const result = await monitor('invoked')
      expect(result.errors).toContain('docker volume inventory unavailable: inventory-offline')
      expect(result.conditions).toContainEqual(expect.objectContaining({
        kind: 'observation-error', detail: expect.stringContaining('inventory-offline'),
      }))
    } finally {
      if (priorHub === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHub
      docker.mockRestore()
    }
  })

  test('a timed-out run Docker inventory becomes a monitor condition, never a clean report', async () => {
    const hubDb = join(dir, 'monitor-docker-timeout-hub.db')
    const binDir = join(dir, 'monitor-docker-timeout-bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\nsleep 1\n')
    chmodSync(join(binDir, 'docker'), 0o755)
    migrateHub(hubDb)
    const priorHub = process.env.HUB_DB
    const priorTimeout = process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
    const docker = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[]) => ({
      exitCode: null, stdout: Buffer.from(''), stderr: Buffer.from(''), success: false,
      exitedDueToTimeout: argv[0] === 'docker',
    })) as unknown as typeof Bun.spawnSync)
    try {
      process.env.HUB_DB = hubDb
      process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS = '25'
      const result = await monitor('invoked')
      expect(result.errors).toContain('docker ps -a inventory unavailable: timed out after 25ms')
      expect(result.conditions.some((row) => row.kind === 'observation-error')).toBe(true)
      expect(result.conditions.some((row) => row.detail.includes('docker orphans  0'))).toBe(false)
    } finally {
      if (priorHub === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHub
      docker.mockRestore()
      if (priorTimeout === undefined) delete process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
      else process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS = priorTimeout
    }
    const invocation = db().query(
      'SELECT id FROM monitor_invocation ORDER BY id DESC LIMIT 1',
    ).get() as { id: number }
    expect(db().query(
      `SELECT count(*) n FROM monitor_condition WHERE invocation_id=? AND kind='observation-error'
        AND detail LIKE '%docker ps -a inventory unavailable: timed out after 25ms%'`,
    ).get(invocation.id)).toEqual({ n: 1 })
  })

  test('does not mark a complete condition list partial when only issue filing fails', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-filing-failure-')))
    git(repo, 'init', '-b', 'main')
    writeFileSync(join(repo, '.git', 'index.lock'), '')
    const project = `monitor-filing-${repo.split('/').pop()}`
    upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
    const hubDb = join(dir, 'monitor-filing-failure-hub.db')
    migrateHub(hubDb)
    const priorHub = process.env.HUB_DB
    const realSpawn = Bun.spawnSync.bind(Bun)
    const docker = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[], options: object) =>
      argv[0] === 'docker'
        ? { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), success: true }
        : realSpawn(argv, options as any)) as typeof Bun.spawnSync)
    try {
      process.env.HUB_DB = hubDb
      const result = await monitor('invoked')
      expect(result.errors).toContain(`could not file dead-lock issue: unknown project "${PLATFORM_SLUG}"`)
      const invocation = db().query(
        'SELECT id FROM monitor_invocation ORDER BY id DESC LIMIT 1',
      ).get() as { id: number }
      expect(db().query(
        `SELECT count(*) n FROM monitor_condition WHERE invocation_id=? AND kind='observation-error'`,
      ).get(invocation.id)).toEqual({ n: 0 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      if (priorHub === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHub
      docker.mockRestore()
    }
  })

  test('marks historical human output partial when that pass had an observation error', () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,1) RETURNING id`,
    ).get() as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(invocation, 'observation-error', `invocation:${invocation}:1`,
      '2026-09-04T00:00:00Z', 0, 'docker inventory unavailable',
      'reported; no state was inferred from the unavailable observation')
    const history = monitorHistory(1) as Array<{ errors: number, conditions: Array<{ detail: string }> }>
    expect(history[0]?.errors).toBe(1)
    expect(history[0]?.conditions[0]?.detail).toBe('docker inventory unavailable')
  })

  test('formats one human pass line, owner and severity included', () => {
    const rows = displayConditions([{
      kind: 'stale-run', subject: 'run:7', age_ms: 120_000, detail: 'detail here',
      action: 'do the thing', issue_key: 'DEV-1', severity: 'attention', owner_session_id: 'sess-9',
    }, {
      kind: 'observation-error', subject: 'docker', age_ms: null, detail: 'inventory failed',
      action: 'retry', issue_key: null, severity: null, owner_session_id: null,
    }])
    expect(rows).toEqual([{
      kind: 'stale-run', subject: 'run:7', ageMs: 120_000, detail: 'detail here',
      action: 'do the thing', issueKey: 'DEV-1', severity: 'attention', ownerSession: 'sess-9',
    }, {
      kind: 'observation-error', subject: 'docker', ageMs: null, detail: 'inventory failed',
      action: 'retry', issueKey: null, severity: null, ownerSession: null,
    }])
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
        session: `owner-session-${i}`,
      })
    }

    const priorHub = process.env.HUB_DB; const priorPath = process.env.PATH
    process.env.HUB_DB = hubDb; process.env.PATH = `${binDir}:${priorPath ?? ''}`
    const result = await monitor('invoked')
    if (priorHub === undefined) delete process.env.HUB_DB; else process.env.HUB_DB = priorHub
    process.env.PATH = priorPath
    const record = db().query(
      'SELECT * FROM monitor_invocation ORDER BY id DESC LIMIT 1',
    ).get() as any
    const conditions = db().query(
      'SELECT * FROM monitor_condition WHERE invocation_id=? ORDER BY id',
    ).all(record.id) as any[]
    const display = displayConditions(conditions)
    expect(display.some((condition) => condition.ownerSession)).toBe(true)
    expect(display).toContainEqual(expect.objectContaining({ subject: `run:${lastRunId}` }))
    expect(display.length).toBeGreaterThanOrEqual(750)
    expect(result.conditions).toHaveLength(record.findings)
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

    const history = monitorHistory(20) as Array<{ conditions: Array<{ detail: string }> }>
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(65_536)
    expect(history[0]?.conditions[0]?.detail).toBe(detail)
  })

})
