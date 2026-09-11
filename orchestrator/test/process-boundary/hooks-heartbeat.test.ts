import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MONITOR_CAPABILITY_PATH_ENV, MONITOR_CAPABILITY_TOKEN_ENV } from '../../../shared/monitor-capability.ts'
import { addRun, allInjectChecks, claimMonitorNotices, markMonitorNoticesDelivered, db, deadRunningProcessConditions, dir, displayConditions, fileIssue, formatMonitorPass, hermeticGitEnv, monitor, monitorHistory, nowIso, parseFiledIssue, reconcileHub, rulingConditions, runWithDelayedStdoutReader, score, setDoc, upsertProject } from '../fixture.ts'

const PROCESS_INSPECTION_AVAILABLE = (() => {
  try { return Bun.spawnSync(['/bin/ps', '-p', String(process.pid), '-o', 'command='],
    { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0 } catch { return false }
})()

describe('architect heartbeat session scope', () => {
  const heartbeat = new URL('../../hooks/orch-heartbeat.sh', import.meta.url).pathname

  const fixture = (orchBody: string, monitorBody = "echo '[]'; exit 0") => {
    const root = mkdtempSync(join(tmpdir(), 'heartbeat-fixture-'))
    const hooks = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooks, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    const copiedHeartbeat = join(hooks, 'orch-heartbeat.sh')
    copyFileSync(heartbeat, copiedHeartbeat)
    chmodSync(copiedHeartbeat, 0o755)
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(fakeOrch, orchBody.replace(
      /^(#![^\n]*\n)/,
      (shebang) => `${shebang}if [ "$1" = "monitor" ]; then ${monitorBody}; fi\n`,
    ))
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

  test('a degraded tick references diagnostics without emitting raw stderr', () => {
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
      expect(p.stdout.toString()).toContain('Inspect orch diagnostics directly')
      expect(p.stdout.toString()).not.toContain('store is locked by pid 99')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a malformed notice response degrades notices but still emits BLOCKED', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[{"can_answer":true}]'
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`, "echo 'not-json'; exit 0")
    try {
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('DEGRADED - monitor notices unavailable')
      expect(p.stdout.toString()).toContain('BLOCKED - 1 question(s) waiting on you')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a failed notice command degrades notices but still emits BLOCKED', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[{"can_answer":true}]'
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`, "echo 'private monitor failure' >&2; exit 19")
    try {
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('monitor notices unavailable (rc=19')
      expect(p.stdout.toString()).not.toContain('private monitor failure')
      expect(p.stdout.toString()).toContain('BLOCKED - 1 question(s) waiting on you')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a hanging notice command is bounded and still emits BLOCKED', () => {
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[{"can_answer":true}]'
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`, "sleep 30; echo '[]'; exit 0")
    try {
      const started = Date.now()
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, NOTICE_TIMEOUT_SECONDS: '0.2' },
      })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('monitor notices unavailable (rc=124')
      expect(p.stdout.toString()).toContain('BLOCKED - 1 question(s) waiting on you')
      expect(p.stdout.toString().indexOf('BLOCKED')).toBeLessThan(
        p.stdout.toString().indexOf('monitor notices unavailable'),
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a hanging notice acknowledgement is bounded after emitting BLOCKED', () => {
    const notice = JSON.stringify([{
      noticeId: 'condition:9', kind: 'stale-run', subject: 'run:9',
      detail: 'Orch detected stale-run for run:9', ownerSession: 'owner',
    }])
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[{"can_answer":true}]'
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`, `if [ "$2" = "--notices" ]; then echo '${notice}'; exit 0; fi; sleep 30`)
    try {
      const started = Date.now()
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, NOTICE_TIMEOUT_SECONDS: '0.2' },
      })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(p.exitCode).toBe(0)
      const out = p.stdout.toString()
      expect(out).toContain('BLOCKED - 1 question(s) waiting on you')
      expect(out).toContain('MONITOR stale-run run:9')
      expect(out).toContain('monitor notice acknowledgement failed')
      expect(out.indexOf('BLOCKED')).toBeLessThan(out.indexOf('MONITOR stale-run'))
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a failed capability mint degrades notices but still emits BLOCKED', () => {
    const notice = JSON.stringify([{
      noticeId: 'condition:9', kind: 'stale-run', subject: 'run:9',
      detail: 'Orch detected stale-run for run:9', ownerSession: 'owner',
    }])
    const f = fixture(`#!/bin/sh
if [ "$1" = "inbox" ]; then
  echo '[{"can_answer":true}]'
elif [ "$1" = "runs" ]; then
  echo '{"id":7,"job":"implement","agent":"codex","status":"asking","session_id":"owner","started_at":"2026-09-05T00:00:00.000Z"}'
else
  exit 20
fi
`, `echo '${notice}'; exit 0`)
    const bin = join(f.root, 'test-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mktemp'), `#!/bin/sh
if [ "$1" = "-d" ]; then exit 73; fi
exec /usr/bin/mktemp "$@"
`)
    chmodSync(join(bin, 'mktemp'), 0o755)
    try {
      const p = Bun.spawnSync([f.heartbeat, 'owner', '0', '1'], {
        stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain('monitor notice delivery capability unavailable')
      expect(p.stdout.toString()).not.toContain('MONITOR stale-run')
      expect(p.stdout.toString()).toContain('BLOCKED - 1 question(s) waiting on you')
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

  test('delivers an addressed monitor condition once while the session is running', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running',
      session: 'heartbeat-monitor-owner' })
    db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(live)
    const invocation = (db().query(
      `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES (?,?,?,?,?) RETURNING id`,
    ).get(nowIso(), nowIso(), 'backstop', 1, 0) as { id: number }).id
    db().query(
      `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(invocation, 'stale-run', 'run:391', '2026-09-08T10:00:00.000Z', 60_000,
      'run 391 is stale', 'reported; disposition requires intent', 'heartbeat-monitor-owner')

    const p = Bun.spawnSync([heartbeat, 'heartbeat-monitor-owner', '0', '2'], {
      stdout: 'pipe', stderr: 'pipe', env: process.env,
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    expect(p.stdout.toString().match(/MONITOR stale-run run:391/g)).toHaveLength(
      PROCESS_INSPECTION_AVAILABLE ? 1 : 2,
    )
    expect(db().query('SELECT delivered_at FROM monitor_condition WHERE subject=?')
      .get('run:391')).toEqual({
        delivered_at: PROCESS_INSPECTION_AVAILABLE ? expect.any(String) : null,
      })
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
    expect(out).toContain(`HARNESS-REFUSED ${harness}/implement codex harness 1.5s; inspect with 'orch run ${harness}'`)
    expect(out).toContain(`FAILED ${failed}/fix grok other 1.5s; inspect with 'orch run ${failed}'`)
    expect(out).not.toContain('caller HEAD behind base')
    expect(out).not.toContain('agent failed')
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
    expect(out.match(new RegExp(`FAILED ${oldRoot}/implement codex other 1\\.5s; inspect with 'orch run ${oldRoot}'`, 'g'))).toHaveLength(1)
    expect(out).not.toContain('child failed')
    expect(out).not.toContain(`FAILED ${recentRoot}/fix`)
  })

  test('a run that finishes between ticks reports FINISHED once', async () => {
    const finishing = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const live = addRun({ agent: 'agy', job: 'craft', status: 'running' })
    for (const id of [finishing, live]) {
      db().query("UPDATE run SET session_id='heartbeat-finisher', latency_ms=NULL WHERE id=?").run(id)
    }
    const p = Bun.spawn([heartbeat, 'heartbeat-finisher', '0', '3'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, NOTICE_TIMEOUT_SECONDS: '0.2' },
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
