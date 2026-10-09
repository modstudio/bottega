import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun } from '../test/fixtures/store.ts'
import { registrationProbeReadsRepo } from './agent/agent-probe.ts'
import { db } from './database/db.ts'
import {
  appendRunEvent,
  createEventLog,
  eventsFromVendorLine,
  idleLabel,
  peekRun,
  runEventsPath,
} from './events.ts'
import type { NormalizedEvent } from './transport/transport.ts'

const CODEX_PROBE_COMMAND_STARTED = JSON.stringify({
  type: 'item.started',
  item: {
    type: 'command_execution',
    command: "sed -n '1,200p' probe.txt",
    status: 'in_progress',
  },
})

const CODEX_PROBE_COMMAND_COMPLETED = JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: "sed -n '1,200p' probe.txt",
    aggregated_output: 'REGISTRATION_PROBE_FILE_OK\n',
    exit_code: 0,
    status: 'completed',
  },
})

const GROK_PROBE_READ_REQUEST = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        name: 'read_file',
        input: { target_file: 'probe.txt' },
      },
    ],
  },
})

const GROK_PROBE_READ_RESULT = JSON.stringify({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        content: 'REGISTRATION_PROBE_FILE_OK\n',
        is_error: false,
      },
    ],
  },
})

function probeEvents(...lines: string[]): NormalizedEvent[] {
  return lines.flatMap((line) => eventsFromVendorLine(line)) as NormalizedEvent[]
}

describe('vendor event log', () => {
  test('non-worker activity appends without moving the activity clock', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET last_event_at=? WHERE id=?').run('worker-time', id)
    appendRunEvent(id, { ts: 'server-time', type: 'ask_initialized' }, runEventsPath(id))
    expect(
      (db().query('SELECT last_event_at FROM run WHERE id=?').get(id) as { last_event_at: string })
        .last_event_at,
    ).toBe('worker-time')
    appendRunEvent(id, { ts: 'next-worker-time', type: 'text', text: 'worker output' })
    expect(
      (db().query('SELECT last_event_at FROM run WHERE id=?').get(id) as { last_event_at: string })
        .last_event_at,
    ).toBe('next-worker-time')
  })

  test('peek does not treat ask lifecycle events as worker activity', () => {
    const startedAt = '2026-09-07T00:00:00.000Z'
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', startedAt })
    appendRunEvent(id, {
      ts: '2026-09-07T00:01:00.000Z',
      type: 'ask_expected',
      transport: 'host',
      command: ['orch', 'ask-server'],
    })
    appendRunEvent(id, {
      ts: '2026-09-07T00:02:00.000Z',
      type: 'ask_started',
      tools: ['ask_orchestrator'],
    })
    appendRunEvent(id, { ts: '2026-09-07T00:03:00.000Z', type: 'ask_initialized' })
    appendRunEvent(id, {
      ts: '2026-09-07T00:04:00.000Z',
      type: 'ask_listed',
      tools: ['ask_orchestrator'],
    })

    const peek = peekRun(id, { now: Date.parse('2026-09-07T00:10:00.000Z') })
    expect(peek).toMatchObject({
      seconds_since_last_event: 600,
      event_count: 4,
      last_event_at: null,
      idle: 'idle 10m',
    })
    expect(peek.events).toHaveLength(4)
  })

  test('coalesces assistant chunks and records tool results without bodies', () => {
    const id = addRun({ agent: 'grok', job: 'summarize', status: 'running' })
    const path = runEventsPath(id)
    const log = createEventLog(id, path)
    log.observe({ kind: 'text', text: 'Hello ' }, 't1')
    log.observe({ kind: 'text', text: 'world' }, 't2')
    log.observe(
      {
        kind: 'tool',
        title: 'Read',
        toolKind: 'read',
        target: 'foo.ts',
        locations: [{ path: 'foo.ts' }],
      },
      't3',
    )
    log.observe(
      {
        kind: 'tool',
        title: 'Read',
        status: 'completed',
        result: 'secret body',
      },
      't4',
    )
    log.observe({ kind: 'usage', tokens: 9, costUsd: null }, 't5')
    log.flush('t6')
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { ts: 't3', type: 'text', text: 'Hello world' },
      { ts: 't3', type: 'tool_call', kind: 'read', title: 'Read', locations: [{ path: 'foo.ts' }] },
      { ts: 't4', type: 'tool_call', title: 'Read' },
      {
        ts: 't4',
        type: 'tool_result',
        status: 'completed',
        bytes: Buffer.byteLength('secret body'),
      },
      { ts: 't5', type: 'usage', tokens: 9, costUsd: null },
    ])
    expect(JSON.stringify(lines)).not.toContain('secret body')
    const row = db().query('SELECT last_event_at FROM run WHERE id=?').get(id) as {
      last_event_at: string
    }
    expect(row.last_event_at).toBe('t5')
  })

  test('parses grok and codex JSON lines into stream events', () => {
    expect(
      eventsFromVendorLine(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
      ),
    ).toEqual([{ kind: 'text', text: 'hi' }])
    expect(
      eventsFromVendorLine(
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', command: 'ls' },
        }),
      )[0],
    ).toMatchObject({ kind: 'tool', title: 'ls', toolKind: 'execute' })
    expect(
      eventsFromVendorLine(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      ),
    ).toEqual([{ kind: 'usage', tokens: 3, costUsd: null }])
    expect(
      eventsFromVendorLine(
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'starship',
            tool: 'task_list',
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool',
        title: 'task_list',
        toolKind: 'mcp',
        server: 'starship',
        status: 'completed',
        locations: undefined,
        target: undefined,
      },
    ])
    expect(
      eventsFromVendorLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'looking' }] },
        }),
      ),
    ).toEqual([{ kind: 'text', text: 'looking' }])
    expect(
      eventsFromVendorLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] },
        }),
      )[0],
    ).toMatchObject({ kind: 'tool', title: 'Read', target: 'a.ts' })
  })

  test('codex 0.160.0 command_execution of the probe file is a repo read', () => {
    const events = probeEvents(CODEX_PROBE_COMMAND_STARTED, CODEX_PROBE_COMMAND_COMPLETED)
    expect(events).toEqual([
      {
        kind: 'tool',
        title: "sed -n '1,200p' probe.txt",
        toolKind: 'execute',
        status: 'in_progress',
        locations: undefined,
      },
      {
        kind: 'tool',
        title: "sed -n '1,200p' probe.txt",
        toolKind: 'execute',
        status: 'completed',
        result: 'REGISTRATION_PROBE_FILE_OK\n',
        locations: undefined,
      },
    ])
    expect(registrationProbeReadsRepo(events, 'REGISTRATION_PROBE_FILE_OK')).toBe(true)
  })

  test('grok 1.0.13 read_file of the probe file is a repo read', () => {
    const events = probeEvents(GROK_PROBE_READ_REQUEST, GROK_PROBE_READ_RESULT)
    expect(events[0]).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      toolKind: 'read',
      target: 'probe.txt',
      locations: [{ path: 'probe.txt' }],
    })
    expect(events[1]).toMatchObject({
      kind: 'tool',
      status: 'completed',
      result: 'REGISTRATION_PROBE_FILE_OK\n',
    })
    expect(registrationProbeReadsRepo(events, 'REGISTRATION_PROBE_FILE_OK')).toBe(true)
  })

  test('an unrelated command and a hallucinated output without the sentinel is not a repo read', () => {
    const events = probeEvents(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', command: 'ls' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'probe.txt\n',
          exit_code: 0,
        },
      }),
    )
    expect(registrationProbeReadsRepo(events, 'I read the file')).toBe(false)
  })

  test('idleLabel is silent until the threshold and then prints idle Nm', () => {
    const started = '2026-09-07T00:00:00.000Z'
    const last = '2026-09-07T00:01:00.000Z'
    const now = Date.parse('2026-09-07T00:06:00.000Z')
    expect(idleLabel(last, started, now, 5 * 60_000)).toBe('idle 5m')
    expect(idleLabel(last, started, now, 6 * 60_000)).toBeNull()
  })
})

describe('the live log is observation, never outcome', () => {
  test('new note events round-trip UUIDs and labels while old numeric lines still read', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    appendRunEvent(id, {
      ts: '2026-10-09T12:00:00.000Z',
      type: 'note',
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidates: [
        { recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' },
      ],
    })
    appendRunEvent(id, {
      ts: '2026-10-09T12:01:00.000Z',
      type: 'note',
      noteId: 72,
      candidateIds: [9],
    })
    expect(peekRun(id, { events: 2 }).events).toEqual([
      { type: 'note', noteLabel: 'workshop#71', candidateLabels: ['workshop#8'] },
      { type: 'note', noteLabel: '72', candidateLabels: ['9'] },
    ])
  })

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
      expect(() =>
        appendRunEvent(0, { ts: new Date().toISOString(), type: 'text', text: 'x' }, bad),
      ).not.toThrow()
      expect(() =>
        appendRunEvent(0, { ts: new Date().toISOString(), type: 'text', text: 'x' }, blocker),
      ).not.toThrow()
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
