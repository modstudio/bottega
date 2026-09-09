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
    status TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL)`)
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

  test('does NOT block a landing-only session, because no watcher can satisfy it', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 11, session: 'land-only', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-only' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    const out = JSON.parse(result.stdout.toString())
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toContain('No watcher covers landings')
  })

  test('reports the landing even when a heartbeat IS armed, since it cannot see it', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 12, session: 'land-armed', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-armed' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db,
      ORCH_HEARTBEAT_PROCESS_LIST: `42 /bin/bash ${f.heartbeat} land-armed 60 60`,
    })
    expect(JSON.parse(result.stdout.toString()).systemMessage).toContain('landing')
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

  test('tells a landing dispatch NOT to arm the heartbeat', () => {
    const result = invoke(remind, {
      session_id: 'land-advice',
      tool_input: { command: `${join(process.cwd(), 'bin', 'orch')} land DEV-405-branch` },
    }, { ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd' })
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext
    expect(context).toContain('NO watcher covers it')
    expect(context).toContain('orch land --status')
    expect(context).not.toContain('Arm under Monitor')
  })

  test('blocks when the session has a live landing and no runs at all', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 7, session: 'land-live', status: 'running' }])
    const result = invoke(f.guard, { session_id: 'land-live' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(result.exitCode).toBe(0)
    const decision = JSON.parse(result.stdout.toString())
    expect(decision.decision).toBeUndefined()
    expect(decision.systemMessage).toContain('live landing')
  })

  test('a queued landing counts as live, not only a running one', () => {
    const f = fixture(noRuns)
    const db = landingDb(f.root, [{ id: 8, session: 'land-queued', status: 'queued' }])
    const result = invoke(f.guard, { session_id: 'land-queued' }, {
      TMPDIR: join(f.root, 'tmp'), ORCH_DB: db, ORCH_HEARTBEAT_PROCESS_LIST: '1 /sbin/launchd',
    })
    expect(JSON.parse(result.stdout.toString()).systemMessage).toContain('live landing')
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
    expect(JSON.parse(result.stdout.toString()).systemMessage).toContain('store unreadable')
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
      .toContain('NO watcher covers it')
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
