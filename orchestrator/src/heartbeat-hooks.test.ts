import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
