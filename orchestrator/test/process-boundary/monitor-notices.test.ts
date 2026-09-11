import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MONITOR_CAPABILITY_PATH_ENV, MONITOR_CAPABILITY_TOKEN_ENV } from '../../../shared/monitor-capability.ts'
import { addRun, allInjectChecks, claimMonitorNotices, markMonitorNoticesDelivered, db, deadRunningProcessConditions, dir, displayConditions, fileIssue, formatMonitorPass, hermeticGitEnv, monitor, monitorHistory, nowIso, parseFiledIssue, reconcileHub, rulingConditions, runWithDelayedStdoutReader, score, setDoc, upsertProject } from '../fixture.ts'

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

describe('monitor process boundary', () => {
  test('a public session id alone cannot acknowledge another session notice', () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES (?,?,?,?,?) RETURNING id`,
    ).get(nowIso(), nowIso(), 'backstop', 1, 0) as { id: number }).id
    const notice = (db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(invocation, 'stale-run', 'run:authority', nowIso(), 1,
      'worker text', 'reported', 'published-session') as { id: number }).id
    const cli = new URL('../../src/cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync(
      [process.execPath, cli, 'monitor', '--ack-notices', String(notice)],
      { env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'published-session' },
        stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('requires a live delivery-hook capability')
    expect(db().query('SELECT delivered_at FROM monitor_condition WHERE id=?').get(notice))
      .toEqual({ delivered_at: null })
  })

  test('notice acknowledgement rejects a forged parent that names a delivery hook as an argument', () => {
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES (?,?,?,?,?) RETURNING id`,
    ).get(nowIso(), nowIso(), 'backstop', 1, 0) as { id: number }).id
    const notice = (db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(invocation, 'stale-run', 'run:authority-ps', nowIso(), 1,
      'worker text', 'reported', 'ps-owner') as { id: number }).id
    const capabilityDir = mkdtempSync(join(tmpdir(), 'monitor-capability-test-'))
    chmodSync(capabilityDir, 0o700)
    const capabilityPath = join(capabilityDir, 'capability.json')
    const forgedParent = join(capabilityDir, 'forged-parent.ts')
    const token = 'valid-test-token'
    const cli = new URL('../../src/cli.ts', import.meta.url).pathname
    const hookArgument = new URL('../hooks/session-brief.py', import.meta.url).pathname
    writeFileSync(forgedParent, `import { chmodSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.CAPABILITY_PATH!, JSON.stringify({
  token: process.env.CAPABILITY_TOKEN, pid: process.pid,
}))
chmodSync(process.env.CAPABILITY_PATH!, 0o600)
const result = Bun.spawnSync([
  process.execPath, process.env.CLI!, 'monitor', '--ack-notices', process.env.NOTICE_ID!,
], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
process.stderr.write(result.stderr)
process.exit(result.exitCode)
`)
    try {
      const result = Bun.spawnSync(
        [process.execPath, forgedParent, hookArgument],
        { env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: 'ps-owner',
          [MONITOR_CAPABILITY_PATH_ENV]: capabilityPath,
          [MONITOR_CAPABILITY_TOKEN_ENV]: token,
          CAPABILITY_PATH: capabilityPath,
          CAPABILITY_TOKEN: token,
          CLI: cli,
          NOTICE_ID: String(notice),
        }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain('requires a live delivery-hook capability')
      expect(db().query('SELECT delivered_at FROM monitor_condition WHERE id=?').get(notice))
        .toEqual({ delivered_at: null })

      const linkedCapability = join(capabilityDir, 'linked-capability.json')
      symlinkSync(capabilityPath, linkedCapability)
      const linked = Bun.spawnSync(
        [process.execPath, cli, 'monitor', '--ack-notices', String(notice)],
        { env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: 'ps-owner',
          [MONITOR_CAPABILITY_PATH_ENV]: linkedCapability,
          [MONITOR_CAPABILITY_TOKEN_ENV]: token,
        }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(linked.exitCode).toBe(1)
      expect(db().query('SELECT delivered_at FROM monitor_condition WHERE id=?').get(notice))
        .toEqual({ delivered_at: null })
    } finally {
      rmSync(capabilityDir, { recursive: true, force: true })
    }
  })

  test('concurrent monitor passes inherit a prior delivery atomically', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'stale',
      session: 'atomic-owner', startedAt: '2026-09-08T10:00:00.000Z' })
    const first = await monitor('invoked')
    const notice = claimMonitorNotices('atomic-owner').find((row) => row.subject === `run:${runId}`)!
    expect(notice).toBeDefined()

    const cli = new URL('../../src/cli.ts', import.meta.url).pathname
    const syncDir = mkdtempSync(join(tmpdir(), 'monitor-concurrency-'))
    const syncBin = join(syncDir, 'bin')
    mkdirSync(syncBin)
    writeFileSync(join(syncBin, 'docker'), `#!/bin/sh
touch "$SYNC_DIR/ready-$$"
while [ ! -f "$SYNC_DIR/release" ]; do sleep 0.01; done
echo '[]'
`)
    chmodSync(join(syncBin, 'docker'), 0o755)
    const env = {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', SYNC_DIR: syncDir,
      PATH: `${syncBin}:${process.env.PATH ?? ''}`,
    }
    const children = [Bun.spawn([process.execPath, cli, 'monitor'], {
      env, stdout: 'ignore', stderr: 'ignore',
    }), Bun.spawn([process.execPath, cli, 'monitor'], {
      env, stdout: 'ignore', stderr: 'ignore',
    })]
    const readyDeadline = Date.now() + 5_000
    while (readdirSync(syncDir).filter((name) => name.startsWith('ready-')).length < 2 &&
           Date.now() < readyDeadline) await Bun.sleep(10)
    expect(readdirSync(syncDir).filter((name) => name.startsWith('ready-'))).toHaveLength(2)
    const marker = Bun.spawn([process.execPath, '-e', `
      import { Database } from 'bun:sqlite'
      const database = new Database(process.env.ORCH_DB)
      database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      database.query('UPDATE monitor_condition SET delivered_at=? WHERE id=?').run(
        new Date().toISOString(), Number(process.env.NOTICE_ID!.split(':')[1]))
      console.log('marked')
      Bun.sleepSync(500)
      database.exec('COMMIT')
    `], { env: { ...env, NOTICE_ID: String(notice.noticeId) }, stdout: 'pipe', stderr: 'pipe' })
    const markerReader = marker.stdout.getReader()
    let markerOutput = ''
    while (!markerOutput.includes('marked')) {
      const chunk = await markerReader.read()
      if (chunk.done) break
      markerOutput += new TextDecoder().decode(chunk.value)
    }
    expect(markerOutput).toContain('marked')
    writeFileSync(join(syncDir, 'release'), '')
    await Promise.all([marker.exited, ...children.map((child) => child.exited)])
    const rows = db().query(
      `SELECT delivered_at FROM monitor_condition
        WHERE kind='stale-run' AND subject=? AND invocation_id>?`,
    ).all(`run:${runId}`, first.id) as { delivered_at: string | null }[]
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.every((row) => row.delivered_at !== null)).toBe(true)
    rmSync(syncDir, { recursive: true, force: true })
  }, 20_000)
})
