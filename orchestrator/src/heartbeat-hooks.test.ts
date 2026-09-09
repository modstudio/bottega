import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'

const guard = new URL('../hooks/heartbeat-guard.py', import.meta.url).pathname
const remind = new URL('../hooks/heartbeat-remind.py', import.meta.url).pathname
const heartbeat = new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(orchBody: string) {
  const root = mkdtempSync(join(tmpdir(), 'heartbeat-hooks-'))
  roots.push(root)
  const hooks = join(root, 'orchestrator', 'hooks')
  mkdirSync(hooks, { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(guard, join(hooks, 'heartbeat-guard.py'))
  copyFileSync(heartbeat, join(hooks, 'orch-heartbeat.sh'))
  const orch = join(root, 'bin', 'orch')
  writeFileSync(orch, `#!/bin/sh\n${orchBody}\n`)
  chmodSync(orch, 0o755)
  return { root, guard: join(hooks, 'heartbeat-guard.py'), heartbeat: join(hooks, 'orch-heartbeat.sh') }
}


function landingDb(root: string, rows: Array<{ id: number; session: string; status: string }>) {
  const db = new Database(join(root, 'orchestrator', 'orch.db'))
  db.run(`CREATE TABLE landing (id INTEGER PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
    heartbeat_delivered_at TEXT)`)
  for (const row of rows) {
    db.run('INSERT INTO landing (id, project, branch, status, session_id, started_at) VALUES (?,?,?,?,?,?)',
      [row.id, PLATFORM_SLUG, 'b', row.status, row.session, '2026-09-08T00:00:00Z'])
  }
  db.close()
  return join(root, 'orchestrator', 'orch.db')
}

function invoke(hook: string, payload: object, env: Record<string, string> = {}) {
  const { CLAUDE_CODE_SESSION_ID: _drop, ...clean } = process.env
  return Bun.spawnSync(['python3', hook], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe', stderr: 'pipe',
    env: { ...clean, ...env },
  })
}

describe('heartbeat Stop guard', () => {
  const runs = [
    { schema_version: 1, data: { id: 9, session_id: 'guard-live', status: 'running' } },
    { schema_version: 1, data: { id: 3, session_id: 'guard-live', status: 'asking' } },
    { schema_version: 1, data: { id: 2, session_id: 'other', status: 'running' } },
  ].map(row => JSON.stringify(row)).join('\n')

  test('blocks once for a live unarmed run set, then warns and allows stop', () => {
    const f = fixture(`printf '%s\\n' '${runs}'`)
    const payload = { session_id: 'guard-live' }
    const env = {
      TMPDIR: join(f.root, 'tmp'),
      ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    }
    const first = invoke(f.guard, payload, env)
    expect(first.exitCode).toBe(0)
    expect(first.stderr.toString()).toBe('')
    const blocked = JSON.parse(first.stdout.toString())
    expect(blocked.decision).toBe('block')
    expect(blocked.reason).toContain('2 live orch runs')
    expect(blocked.reason).toContain(`${f.heartbeat} guard-live`)

    const second = invoke(f.guard, payload, env)
    const warned = JSON.parse(second.stdout.toString())
    expect(warned.decision).toBeUndefined()
    expect(warned.systemMessage).toContain('one-shot heartbeat guard')
    expect(warned.systemMessage).toContain('2 live orch runs')
  })

  test('is silent when the injected real-process shape contains a matching heartbeat', () => {
    const f = fixture(`printf '%s\\n' '${runs}'`)
    const result = invoke(f.guard, { session_id: 'guard-live' }, {
      TMPDIR: join(f.root, 'tmp'),
      ORCH_HEARTBEAT_PROCESS_LIST: `42 /bin/bash ${f.heartbeat} guard-live 60 60`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })

  test('is silent when this session has no live runs', () => {
    const terminal = JSON.stringify({ data: { id: 9, session_id: 'guard-done', status: 'ok' } })
    const f = fixture(`printf '%s\\n' '${terminal}'`)
    const result = invoke(f.guard, { session_id: 'guard-done' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  })

  test('fails open when orch exits non-zero', () => {
    const f = fixture('exit 7')
    const result = invoke(f.guard, { session_id: 'guard-error' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })

  test('fails open when orch emits garbage', () => {
    const f = fixture('echo not-json')
    const result = invoke(f.guard, { session_id: 'guard-garbage' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })

  test('fails open after five seconds when orch hangs', () => {
    const f = fixture('exec sleep 20')
    const started = performance.now()
    const result = invoke(f.guard, { session_id: 'guard-timeout' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_500)
    expect(performance.now() - started).toBeLessThan(7_000)
  }, 8_000)
})

describe('heartbeat dispatch reminder', () => {
  test('adds the exact arm command after detached orch do', () => {
    const result = invoke(remind, {
      session_id: 'remind-detached',
      tool_input: { command: 'orch do implement --key DEV-405 --spec /tmp/spec' },
    }, { ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd' })
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout.toString())
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `${heartbeat} remind-detached`,
    )
  })

  test('is silent for a followed orch do', () => {
    const result = invoke(remind, {
      session_id: 'remind-follow',
      tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} do --follow implement` },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  })

  test('is silent when the injected real-process shape contains a matching heartbeat', () => {
    const result = invoke(remind, {
      session_id: 'remind-armed',
      tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} do implement --key DEV-405` },
    }, { ORCH_HEARTBEAT_PROCESS_LIST: '42 /bin/bash /main/orchestrator/hooks/orch-heartbeat.sh remind-armed 60 60' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })
})

describe('heartbeat landing visibility', () => {
  const noRuns = 'exit 0'
  const heartbeatOrch = `
if [ "$1" = "inbox" ]; then
  echo '[]'
elif [ "$1" = "runs" ]; then
  echo '{"id":1,"job":"implement","agent":"codex","status":"ok","session_id":"other","started_at":"2026-09-08T00:00:00Z","latency_ms":1}'
elif [ "$1" = "monitor" ]; then
  if [ "$2" = "--notices" ]; then
    python3 -c '
import datetime, json, os, sqlite3
db = sqlite3.connect(os.environ["ORCH_DB"])
rows = db.execute("SELECT id,branch,status,session_id,started_at,finished_at FROM landing WHERE session_id=? AND heartbeat_delivered_at IS NULL AND status IN (?,?,?) ORDER BY id", (os.environ["CLAUDE_CODE_SESSION_ID"], "refused", "rebase_required", "install_failed")).fetchall()
out = []
for i, branch, status, session, started_at, finished_at in rows:
    started = datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    finished = datetime.datetime.fromisoformat((finished_at or started_at).replace("Z", "+00:00"))
    elapsed = max(0, round((finished - started).total_seconds()))
    duration = "%dm%02ds" % (elapsed // 60, elapsed % 60) if elapsed >= 60 else "%.1fs" % elapsed
    event = {"refused":"LANDING-REFUSED","rebase_required":"LANDING-REBASE-REQUIRED","install_failed":"LANDING-INSTALL-FAILED"}[status]
    out.append({"noticeId":"landing:" + str(i),"kind":"landing-" + status.replace("_", "-"),"subject":"landing:" + str(i),"detail":event + " " + str(i) + "/" + branch + " " + duration + "; inspect with " + chr(39) + "orch land --status" + chr(39),"ownerSession":session})
print(json.dumps(out))
'
  elif [ "$2" = "--ack-notices" ]; then
    if [ "\${KILL_ON_LANDING_ACK:-}" = "1" ]; then kill -9 "$PPID"; exit 137; fi
    IDS="$3" python3 -c '
import datetime, os, sqlite3
db = sqlite3.connect(os.environ["ORCH_DB"])
for value in os.environ["IDS"].split(","):
    source, identifier = value.split(":", 1)
    if source == "landing":
        db.execute("UPDATE landing SET heartbeat_delivered_at=? WHERE id=? AND session_id=? AND heartbeat_delivered_at IS NULL", (datetime.datetime.now(datetime.timezone.utc).isoformat(), int(identifier), os.environ["CLAUDE_CODE_SESSION_ID"]))
db.commit()
'
  else
    exit 20
  fi
else
  exit 20
fi`

  test('heartbeat reports WAITING with the branch for landing-only work, then clears silently', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 21, session: 'landing-watch', status: 'running' }])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=?, started_at=? WHERE id=21',
      ['DEV-423-landing-watch', new Date(Date.now() - 65_000).toISOString()])
    const p = Bun.spawn([f.heartbeat, 'landing-watch', '0.2', '5'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const output = new Response(p.stdout).text()
    await Bun.sleep(500)
    store.run("UPDATE landing SET status='landed', finished_at=? WHERE id=21", [new Date().toISOString()])
    store.close()
    const out = await output
    expect(await p.exited).toBe(0)
    expect(out).toContain('WAITING - 0 run(s) and 1 landing(s)')
    expect(out).toContain('21/DEV-423-landing-watch running 1m')
    expect(out.match(/WAITING/g)).toHaveLength(1)
    expect(out).not.toContain('CLEAR')
    expect(out).not.toContain('HEARTBEAT ENDED')
  })

  test('heartbeat emits a landing refusal exactly once', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [
      { id: 31, session: 'landing-refusal', status: 'running' },
      { id: 32, session: 'landing-refusal', status: 'queued' },
    ])
    const store = new Database(dbPath)
    const started = new Date(Date.now() - 2_000).toISOString()
    store.run('UPDATE landing SET branch=?, started_at=? WHERE id=31', ['DEV-423-refused', started])
    store.run('UPDATE landing SET branch=?, started_at=? WHERE id=32', ['DEV-423-still-live', started])
    const p = Bun.spawn([f.heartbeat, 'landing-refusal', '0.2', '4'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const output = new Response(p.stdout).text()
    await Bun.sleep(500)
    store.run("UPDATE landing SET status='refused', finished_at=? WHERE id=31", [new Date().toISOString()])
    store.close()
    const out = await output
    expect(await p.exited).toBe(0)
    expect(out.match(/LANDING-REFUSED 31\/DEV-423-refused/g), out).toHaveLength(1)
    expect(out).toContain("inspect with 'orch land --status'")
  })

  test('a queued landing becoming rebase-required emits once and then clears silently', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 41, session: 'landing-rebase', status: 'queued' }])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=?, started_at=? WHERE id=41',
      ['DEV-423-needs-rebase', new Date(Date.now() - 2_000).toISOString()])
    const p = Bun.spawn([f.heartbeat, 'landing-rebase', '0.1', '8'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const output = new Response(p.stdout).text()
    await Bun.sleep(500)
    store.run("UPDATE landing SET status='rebase_required' WHERE id=41")
    store.close()
    const out = await output
    expect(await p.exited).toBe(0)
    expect(out.match(/WAITING/g)).toHaveLength(1)
    expect(out.match(/LANDING-REBASE-REQUIRED 41\/DEV-423-needs-rebase/g), out).toHaveLength(1)
    expect(out).not.toContain('CLEAR')
    expect(out).not.toContain('HEARTBEAT ENDED')
  })

  test('arming against an already rebase-required landing emits once and exits', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 42, session: 'landing-late-rebase', status: 'rebase_required' }])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=?, started_at=? WHERE id=42',
      ['DEV-423-already-needs-rebase', new Date(Date.now() - 2_000).toISOString()])
    store.close()
    const p = Bun.spawn([f.heartbeat, 'landing-late-rebase', '0.1', '3'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(out.match(/LANDING-REBASE-REQUIRED 42\/DEV-423-already-needs-rebase/g)).toHaveLength(1)
    expect(out).not.toContain('WAITING')
    expect(out).not.toContain('HEARTBEAT ENDED')
  })

  test('a persistent rebase-required landing does not re-emit while other work remains live', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [
      { id: 43, session: 'landing-persistent-rebase', status: 'rebase_required' },
      { id: 44, session: 'landing-persistent-rebase', status: 'running' },
    ])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=? WHERE id=43', ['DEV-423-persistent-rebase'])
    store.close()
    const p = Bun.spawn([f.heartbeat, 'landing-persistent-rebase', '0.1', '3'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2', KEEPALIVE_TICKS: '20' },
    })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(out.match(/LANDING-REBASE-REQUIRED 43\/DEV-423-persistent-rebase/g)).toHaveLength(1)
    expect(out.match(/WAITING/g)).toHaveLength(1)
  })

  test('an install-failed landing emits once as a terminal failure and exits', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 45, session: 'landing-install-failed', status: 'install_failed' }])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=?, started_at=?, finished_at=? WHERE id=45', [
      'DEV-423-install-failed', new Date(Date.now() - 2_000).toISOString(), new Date().toISOString(),
    ])
    store.close()
    const p = Bun.spawn([f.heartbeat, 'landing-install-failed', '0.1', '3'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(out.match(/LANDING-INSTALL-FAILED 45\/DEV-423-install-failed/g)).toHaveLength(1)
    expect(out).not.toContain('WAITING')
    expect(out).not.toContain('HEARTBEAT ENDED')
  })

  test('receipts survive re-arming and preserve refusals created while no watcher is armed', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [
      { id: 51, session: 'landing-receipts', status: 'refused' },
      { id: 52, session: 'landing-receipts', status: 'refused' },
      { id: 53, session: 'landing-receipts', status: 'landed' },
    ])
    const store = new Database(dbPath)
    const finished = new Date().toISOString()
    store.run('UPDATE landing SET branch=?, finished_at=?, heartbeat_delivered_at=? WHERE id=51',
      ['DEV-438-already-seen', finished, finished])
    store.run('UPDATE landing SET branch=?, finished_at=? WHERE id=52', ['DEV-438-new', finished])
    store.run('UPDATE landing SET branch=?, finished_at=? WHERE id=53', ['DEV-438-offline', finished])

    const arm = () => Bun.spawnSync([f.heartbeat, 'landing-receipts', '0', '1'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const first = arm()
    expect(first.exitCode, first.stderr.toString()).toBe(0)
    expect(first.stdout.toString()).not.toContain('DEV-438-already-seen')
    expect(first.stdout.toString().match(/LANDING-REFUSED 52\/DEV-438-new/g)).toHaveLength(1)
    expect(store.query('SELECT heartbeat_delivered_at FROM landing WHERE id=52').get())
      .toEqual({ heartbeat_delivered_at: expect.any(String) })

    const second = arm()
    expect(second.exitCode, second.stderr.toString()).toBe(0)
    expect(second.stdout.toString()).toBe('')

    store.run("UPDATE landing SET status='install_failed', finished_at=? WHERE id=53", [new Date().toISOString()])
    const afterOfflineFailure = arm()
    expect(afterOfflineFailure.exitCode, afterOfflineFailure.stderr.toString()).toBe(0)
    expect(afterOfflineFailure.stdout.toString().match(
      /LANDING-INSTALL-FAILED 53\/DEV-438-offline/g,
    )).toHaveLength(1)
    store.close()
  })

  test('a process killed after emission but before acknowledgement re-emits next arming', () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 61, session: 'landing-interrupted', status: 'refused' }])
    const store = new Database(dbPath)
    store.run('UPDATE landing SET branch=?, finished_at=? WHERE id=61',
      ['DEV-438-interrupted', new Date().toISOString()])
    const interrupted = Bun.spawnSync([f.heartbeat, 'landing-interrupted', '0', '1'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2', KILL_ON_LANDING_ACK: '1' },
    })
    expect(interrupted.exitCode).not.toBe(0)
    expect(interrupted.stdout.toString()).toContain('LANDING-REFUSED 61/DEV-438-interrupted')
    expect(store.query('SELECT heartbeat_delivered_at FROM landing WHERE id=61').get())
      .toEqual({ heartbeat_delivered_at: null })

    const rearmed = Bun.spawnSync([f.heartbeat, 'landing-interrupted', '0', '1'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    expect(rearmed.exitCode, rearmed.stderr.toString()).toBe(0)
    expect(rearmed.stdout.toString()).toContain('LANDING-REFUSED 61/DEV-438-interrupted')
    expect(store.query('SELECT heartbeat_delivered_at FROM landing WHERE id=61').get())
      .toEqual({ heartbeat_delivered_at: expect.any(String) })
    store.close()
  })

  test('heartbeat exits silently when this session has no runs or landings', async () => {
    const f = fixture(heartbeatOrch)
    const dbPath = landingDb(f.root, [{ id: 46, session: 'somebody-else', status: 'running' }])
    const p = Bun.spawn([f.heartbeat, 'landing-clear', '0.1', '3'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: dbPath, NOTICE_TIMEOUT_SECONDS: '0.2' },
    })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(out).toBe('')
  })

  test('blocks a landing-only session until its heartbeat is armed', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 11, session: 'land-only', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-only' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    const out = JSON.parse(result.stdout.toString())
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('0 live orch runs and 1 landing')
    expect(out.reason).toContain(`${f.heartbeat} land-only`)
  })

  test('is silent for a landing-only session when its heartbeat is armed', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 12, session: 'land-armed', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-armed' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db,
      ORCH_HEARTBEAT_PROCESS_LIST: `42 /bin/bash ${f.heartbeat} land-armed 60 60`,
    })
    expect(result.stdout.toString()).toBe('')
  })

  test('a landing alongside live runs still blocks, and names both', () => {
    const f = fixture(`echo '{"schema_version":1,"data":{"id":5,"session_id":"mixed","status":"running"}}'`)
    const db = landingDb(f.root, [{ id: 13, session: 'mixed', status: 'queued' }])
    const result = invoke(f.guard, { session_id: 'mixed' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    const out = JSON.parse(result.stdout.toString())
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('1 live orch run')
    expect(out.reason).toContain('1 landing')
  })

  test('tells a detached landing dispatch to arm the heartbeat', () => {
    const result = invoke(remind, {
      session_id: 'land-advice',
      tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} land DEV-405-branch` },
    }, { ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd' })
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext
    expect(context).toContain(`Arm under Monitor from the main checkout: ${heartbeat} land-advice`)
  })

  test('blocks when the session has a live landing and no runs at all', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 7, session: 'land-live', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-live' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    const decision = JSON.parse(result.stdout.toString())
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('1 landing')
  })

  test('a queued landing counts as live, not only a running one', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 8, session: 'land-queued', status: 'queued' }])
    const result = invoke(f.guard, { session_id: 'land-queued' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(JSON.parse(result.stdout.toString()).decision).toBe('block')
  })

  test('another session\'s landing is not this session\'s work', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 9, session: 'somebody-else', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-quiet' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  })

  test('a finished landing is not live', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 10, session: 'land-done', status: 'landed' }])
    const result = invoke(f.guard, { session_id: 'land-done' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.stdout.toString()).toBe('')
  })

  test('an unreadable landing store fails toward live rather than reporting clear', () => {
    const f = fixture(noRuns)
    const corrupt = join(f.root, 'orchestrator', 'orch.db')
    writeFileSync(corrupt, 'this is not a sqlite database')
    const result = invoke(f.guard, { session_id: 'land-unknown' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: corrupt, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    const out = JSON.parse(result.stdout.toString())
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('store unreadable')
  })

  test('an absent landing store is silence, not a block', () => {
    const f = fixture(noRuns)
    const result = invoke(f.guard, { session_id: 'land-nodb' }, {
      TMPDIR: join(f.root, 'tmp'),
      ORCH_DB: join(f.root, 'orchestrator', 'nothing-here.db'),
      ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  })

  test('reminds after a detached orch land', () => {
    const result = invoke(remind, {
      session_id: 'land-remind',
      tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} land DEV-405-branch` },
    }, { ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd' })
    expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext)
      .toContain(`Arm under Monitor from the main checkout: ${heartbeat} land-remind`)
  })

  test('is silent for orch land --wait, --status and --drain', () => {
    for (const tail of ['DEV-405-branch --wait', '--status', '--drain']) {
      const result = invoke(remind, {
        session_id: 'land-remind',
        tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} land ${tail}` },
      }, { ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd' })
      expect(result.stdout.toString()).toBe('')
    }
  })
})
