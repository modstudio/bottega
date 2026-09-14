import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../test/fixtures/store.ts'
import { AGENTS } from './agents.ts'
import { db } from './db.ts'
import { run as runJob } from './run.ts'
import {
  createEventLog, eventsFromVendorLine, formatPeek, idleLabel, peekRun, runEventsPath,
} from './events.ts'
import { idleRunConditions } from './monitor.ts'

const cli = (args: string[], env: Record<string, string> = {}, cwd = dir) => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, 'orch.ts'), ...args], {
    cwd,
    env: {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      CLAUDE_CODE_SESSION_ID: 'orch-test-session', ...env,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('vendor event log', () => {
  test('coalesces assistant chunks and records tool results without bodies', () => {
    const id = addRun({ agent: 'grok', job: 'summarize', status: 'running' })
    const path = runEventsPath(id)
    const log = createEventLog(id, path)
    log.observe({ kind: 'text', text: 'Hello ' }, 't1')
    log.observe({ kind: 'text', text: 'world' }, 't2')
    log.observe({
      kind: 'tool', title: 'Read', toolKind: 'read', target: 'foo.ts',
      locations: [{ path: 'foo.ts' }],
    }, 't3')
    log.observe({
      kind: 'tool', title: 'Read', status: 'completed', result: 'secret body',
    }, 't4')
    log.observe({ kind: 'usage', tokens: 9, costUsd: null }, 't5')
    log.flush('t6')
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { ts: 't3', type: 'text', text: 'Hello world' },
      { ts: 't3', type: 'tool_call', kind: 'read', title: 'Read', locations: [{ path: 'foo.ts' }] },
      { ts: 't4', type: 'tool_call', title: 'Read' },
      { ts: 't4', type: 'tool_result', status: 'completed', bytes: Buffer.byteLength('secret body') },
      { ts: 't5', type: 'usage', tokens: 9, costUsd: null },
    ])
    expect(JSON.stringify(lines)).not.toContain('secret body')
    const row = db().query('SELECT last_event_at FROM run WHERE id=?').get(id) as { last_event_at: string }
    expect(row.last_event_at).toBe('t5')
  })

  test('parses grok and codex JSON lines into stream events', () => {
    expect(eventsFromVendorLine(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    )).toEqual([{ kind: 'text', text: 'hi' }])
    expect(eventsFromVendorLine(JSON.stringify({
      type: 'item.started', item: { type: 'command_execution', command: 'ls' },
    }))[0]).toMatchObject({ kind: 'tool', title: 'ls', toolKind: 'execute' })
    expect(eventsFromVendorLine(JSON.stringify({
      type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 },
    }))).toEqual([{ kind: 'usage', tokens: 3, costUsd: null }])
    expect(eventsFromVendorLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] },
    }))).toEqual([{ kind: 'text', text: 'looking' }])
    expect(eventsFromVendorLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] },
    }))[0]).toMatchObject({ kind: 'tool', title: 'Read', target: 'a.ts' })
  })

  test('idleLabel is silent until the threshold and then prints idle Nm', () => {
    const started = '2026-09-07T00:00:00.000Z'
    const last = '2026-09-07T00:01:00.000Z'
    const now = Date.parse('2026-09-07T00:06:00.000Z')
    expect(idleLabel(last, started, now, 5 * 60_000)).toBe('idle 5m')
    expect(idleLabel(last, started, now, 6 * 60_000)).toBeNull()
  })

  test('a fake vendor script tees events as they arrive and peek works after it finishes', async () => {
    const script = join(dir, 'fake-vendor-events.sh')
    writeFileSync(script, `#!/usr/bin/env python3
import sys, time
def emit(obj):
    sys.stdout.write(obj + "\\n")
    sys.stdout.flush()
emit('{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}')
emit('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"foo.ts"}}]}}')
time.sleep(1)
emit('{"type":"user","message":{"content":[{"type":"tool_result","content":"file body"}]}}')
emit('{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":3,"output_tokens":4}}')
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    let elsewhere: string | undefined
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'summarize', status: 'running' })
      const running = runJob({
        job: 'summarize', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved, noFailover: true,
      })
      const path = runEventsPath(reserved)
      const until = Date.now() + 8_000
      while (Date.now() < until) {
        if (existsSync(path) && readFileSync(path, 'utf8').trim().split('\n').length >= 2) break
        await Bun.sleep(20)
      }
      expect(existsSync(path)).toBe(true)
      const during = peekRun(reserved)
      expect(during.event_count).toBeGreaterThanOrEqual(2)
      expect(during.events.some((event) => event.type === 'text' && event.text.includes('working'))).toBe(true)
      expect(during.events.some((event) => event.type === 'tool_call' && event.title === 'Read')).toBe(true)
      const later = peekRun(reserved, { now: Date.now() + 2_000 })
      expect(later.seconds_since_last_event ?? 0).toBeGreaterThan(during.seconds_since_last_event ?? 0)
      await running
      const finished = peekRun(reserved)
      expect(finished.status).not.toBe('running')
      expect(finished.event_count).toBeGreaterThanOrEqual(during.event_count)
      expect(finished.vendor_tokens).toBe(7)
      const peeked = cli(['peek', String(reserved), '--events', '10'])
      expect(peeked.code, peeked.err).toBe(0)
      expect(peeked.out).toContain(`run ${reserved}`)
      expect(peeked.out).toContain('working on it')
      elsewhere = join(dir, `peek-cwd-${reserved}`)
      mkdirSync(elsewhere)
      const fromElsewhere = cli(['peek', String(reserved), '--json'], {}, elsewhere)
      expect(fromElsewhere.code, fromElsewhere.err).toBe(0)
      const body = JSON.parse(fromElsewhere.out) as { event_count: number; vendor_tokens: number }
      expect(body.event_count).toBeGreaterThanOrEqual(2)
      expect(body.vendor_tokens).toBe(7)
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      if (elsewhere) rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('runs marks idle after the threshold and peek on a finished run reads the file', () => {
    const id = addRun({ agent: 'grok', job: 'summarize', status: 'running' })
    mkdirSync(join(dir, 'runs', String(id)), { recursive: true })
    const path = runEventsPath(id)
    writeFileSync(path, [
      JSON.stringify({ ts: '2026-09-07T00:00:00.000Z', type: 'text', text: 'still going' }),
      JSON.stringify({ ts: '2026-09-07T00:00:01.000Z', type: 'usage', tokens: 11 }),
    ].join('\n') + '\n')
    const last = new Date(Date.now() - 6 * 60_000).toISOString()
    db().query('UPDATE run SET last_event_at=?, status=? WHERE id=?').run(last, 'running', id)
    const listed = cli(['runs', '--id', String(id)])
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out).toContain('idle 6m')
    const json = cli(['runs', '--id', String(id), '--json'])
    expect(json.out).toContain('"idle":"idle 6m"')
    db().query("UPDATE run SET status='ok' WHERE id=?").run(id)
    const peeked = peekRun(id)
    expect(peeked.event_count).toBe(2)
    expect(peeked.vendor_tokens).toBe(11)
    expect(formatPeek(peeked)).toContain('still going')
    const limited = peekRun(id, { events: 1 })
    expect(limited.event_count).toBe(2)
    expect(limited.events).toEqual([{ type: 'usage', tokens: 11 }])
    const conditions = idleRunConditions(Date.now())
    expect(conditions.some((row) => row.subject === `run:${id}`)).toBe(false)
    db().query("UPDATE run SET status='running' WHERE id=?").run(id)
    expect(idleRunConditions().some((row) =>
      row.kind === 'idle' && row.subject === `run:${id}` && row.detail.includes('idle 6m'),
    )).toBe(true)
  })

  test('tell --ping queues the note and prints the peek summary', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', session: 'orch-test-session' })
    db().query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?').run('worker', 'token', id)
    mkdirSync(join(dir, 'runs', String(id)), { recursive: true })
    writeFileSync(runEventsPath(id), `${JSON.stringify({
      ts: new Date().toISOString(), type: 'text', text: 'editing the handler',
    })}\n`)
    const told = cli(['tell', String(id), '--ping', 'keep the public shape'])
    expect(told.code, told.err).toBe(0)
    expect(told.out).toContain('queued message')
    expect(told.out).toContain('editing the handler')
  })
})

describe('the live log is observation, never outcome', () => {
  test('an unwritable events path loses the line and throws nothing', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { appendRunEvent, teeTransportEvents } = await import('./events.ts')
    const dir = mkdtempSync(join(tmpdir(), 'orch-events-unwritable-'))
    try {
      const blocker = join(dir, 'events.jsonl')
      writeFileSync(join(dir, 'parent'), '')
      // The parent of the path is a regular file, so mkdir and append both fail.
      const bad = join(dir, 'parent', 'events.jsonl')
      expect(() => appendRunEvent(0, { ts: new Date().toISOString(), type: 'text', text: 'x' }, bad)).not.toThrow()
      expect(() => appendRunEvent(0, { ts: new Date().toISOString(), type: 'text', text: 'x' }, blocker)).not.toThrow()
      async function* broken() {
        yield { kind: 'text', text: 'one' }
        throw new Error('vendor stream broke')
      }
      await expect(teeTransportEvents(broken(), 0)).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
