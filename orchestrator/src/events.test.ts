import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../test/fixtures/store.ts'
import { registrationProbeReadsRepo } from './agent/agent-probe.ts'
import { db } from './database/db.ts'
import {
  appendRunEvent,
  createEventLog,
  eventsFromVendorLine,
  formatPeek,
  idleLabel,
  isToolCallStart,
  peekRun,
  type RunLogEvent,
  recordRunWarning,
  redactRunLogEvent,
  runEventsPath,
} from './events.ts'
import type { NormalizedEvent } from './transport/transport.ts'
import { startCliStreamReaders } from './transport/transport-cli.ts'

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

function secretShapedValue(): string {
  return ['Bearer ', 'z'.repeat(24)].join('')
}

const redactedTextCases: Array<{
  name: string
  event: (text: string) => RunLogEvent
  read: (event: RunLogEvent) => string | null | undefined
}> = [
  {
    name: 'text.text',
    event: (text) => ({ ts: 't1', type: 'text', text }),
    read: (event) => (event.type === 'text' ? event.text : undefined),
  },
  {
    name: 'warning.text',
    event: (text) => ({ ts: 't1', type: 'warning', text }),
    read: (event) => (event.type === 'warning' ? event.text : undefined),
  },
  {
    name: 'tool_result.text',
    event: (text) => ({ ts: 't1', type: 'tool_result', text }),
    read: (event) => (event.type === 'tool_result' ? event.text : undefined),
  },
  {
    name: 'tool_call.title',
    event: (text) => ({ ts: 't1', type: 'tool_call', title: text }),
    read: (event) => (event.type === 'tool_call' ? event.title : undefined),
  },
  {
    name: 'tool_call.input',
    event: (text) => ({ ts: 't1', type: 'tool_call', title: 'read', input: text }),
    read: (event) => (event.type === 'tool_call' ? event.input : undefined),
  },
  {
    name: 'ask_exposure.note',
    event: (text) => ({
      ts: 't1',
      type: 'ask_exposure',
      surface: 'code-mode',
      cli_version: null,
      note: text,
    }),
    read: (event) => (event.type === 'ask_exposure' ? event.note : undefined),
  },
]

test.each(redactedTextCases)('redactRunLogEvent masks $name', ({ event, read }) => {
  const secret = secretShapedValue()
  const redacted = read(redactRunLogEvent(event(`before ${secret} after`)))
  expect(redacted).toBe('before [withheld: bearer] after')
  expect(redacted).not.toContain(secret)
})

test('redactRunLogEvent returns an event without free text unchanged', () => {
  const event: RunLogEvent = { ts: 't1', type: 'capacity_wait', waiting: true }
  expect(redactRunLogEvent(event)).toBe(event)
})

test('appendRunEvent redacts worker-note refusal detail in the durable log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-events-redaction-'))
  const path = join(dir, 'events.jsonl')
  const secret = secretShapedValue()
  const prefix = 'worker note request 3 was refused: '
  try {
    appendRunEvent('', { ts: 't1', type: 'text', text: `${prefix}${secret}` }, path)
    const written = readFileSync(path, 'utf8')
    expect(written).toContain(prefix)
    expect(written).not.toContain(secret)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('vendor event log', () => {
  test('a CLI tool_use and tool_result pair contains one tool-call start', () => {
    const events = eventsFromVendorLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'x' } },
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      }),
    ).filter((event): event is Extract<NormalizedEvent, { kind: 'tool' }> => event.kind === 'tool')
    expect(events.filter(isToolCallStart)).toHaveLength(1)
    expect(events.map((event) => event.toolCallId)).toEqual(['call-1', 'call-1'])
  })

  test('a Codex item started and completed contains one tool-call start', () => {
    const started = eventsFromVendorLine(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item-1', type: 'command_execution', command: 'rg pattern' },
      }),
    )
    const completed = eventsFromVendorLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item-1',
          type: 'command_execution',
          command: 'rg pattern',
          exit_code: 0,
        },
      }),
    )
    const events = [...started, ...completed].filter(
      (event): event is Extract<NormalizedEvent, { kind: 'tool' }> => event.kind === 'tool',
    )
    expect(events.filter(isToolCallStart)).toHaveLength(1)
    expect(events.map((event) => event.toolCallId)).toEqual(['item-1', 'item-1'])
  })

  test('CLI retry lines record one throttled event with routed concurrency', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const path = runEventsPath(id)
    const log = createEventLog(id, () => 7, path)
    async function* lines(line: string) {
      yield `${line}\n`
    }
    const readers = startCliStreamReaders({
      stderr: lines(
        '2026-10-21T20:00:00Z WARN codex_core: retrying sampling request (1/5 in 224.999951542s) ... last status: 429 Too Many Requests',
      ),
      stdout: lines(
        JSON.stringify({
          type: 'error',
          message: 'Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)',
        }),
      ),
      codex: true,
      push: (event) => {
        if (
          event.kind === 'text' ||
          event.kind === 'tool' ||
          event.kind === 'usage' ||
          event.kind === 'throttled'
        )
          log.observe(event, '2026-10-21T20:00:00.000Z')
      },
    })
    await Promise.all([readers.stdoutTask, readers.stderrTask])
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      ts: '2026-10-21T20:00:00.000Z',
      type: 'throttled',
      max: 5,
      status: 429,
      concurrency: 7,
    })
  })

  test('peek preserves and formats focused test evidence', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    appendRunEvent(id, {
      ts: '2026-10-15T12:00:00.000Z',
      type: 'focused_test',
      paths: ['tests/one.test.ts'],
      started: true,
      exitCode: 1,
      timedOut: false,
      elapsedMs: 42,
      logName: 'focused-test-request.log',
      logPath: '/runs/1/scratch/focused-test-request.log',
    })
    const peek = peekRun(id)
    expect(peek.events.at(-1)).toEqual({
      type: 'focused_test',
      paths: ['tests/one.test.ts'],
      started: true,
      exitCode: 1,
      timedOut: false,
      elapsedMs: 42,
      logName: 'focused-test-request.log',
    })
    expect(formatPeek(peek)).toContain(
      'focused test exit 1 42ms tests/one.test.ts (focused-test-request.log)',
    )
  })

  test('peek names a tool burst observation rather than an ask event', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    appendRunEvent(id, {
      ts: '2026-10-31T12:00:00.000Z',
      type: 'tool_burst_observed',
      count: 64,
      windowMs: 1000,
      peakAt: '2026-10-31T12:00:00.000Z',
    })
    const peek = peekRun(id)
    expect(peek.events.at(-1)).toEqual({ type: 'tool_burst_observed', count: 64, windowMs: 1000 })
    expect(formatPeek(peek)).toContain('tool burst 64 starts in 1000ms')
  })

  test('peek preserves and formats ask exposure evidence', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    appendRunEvent(id, {
      ts: '2026-10-31T12:00:00.000Z',
      type: 'ask_exposure',
      surface: 'code-mode',
      cli_version: '0.166.0',
      note: 'code-mode means exec offered, nested set not enumerated; not proof run_tests was reachable',
    })
    expect(peekRun(id).events.at(-1)).toEqual({
      type: 'ask_exposure',
      surface: 'code-mode',
      cli_version: '0.166.0',
      note: 'code-mode means exec offered, nested set not enumerated; not proof run_tests was reachable',
    })
    expect(formatPeek(peekRun(id))).toContain('ask exposure code-mode 0.166.0')
  })

  test('non-worker activity appends without moving the activity clock', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET last_event_at=? WHERE record_id=?').run('worker-time', id)
    appendRunEvent(id, { ts: 'server-time', type: 'ask_initialized' }, runEventsPath(id))
    recordRunWarning(id, 'capacity bound reached')
    expect(
      (
        db().query('SELECT last_event_at FROM run WHERE record_id=?').get(id) as {
          last_event_at: string
        }
      ).last_event_at,
    ).toBe('worker-time')
    expect(peekRun(id).events.at(-1)).toEqual({
      type: 'warning',
      text: 'capacity bound reached',
    })
    expect(formatPeek(peekRun(id))).toContain('warning capacity bound reached')
    appendRunEvent(id, { ts: 'next-worker-time', type: 'text', text: 'worker output' })
    expect(
      (
        db().query('SELECT last_event_at FROM run WHERE record_id=?').get(id) as {
          last_event_at: string
        }
      ).last_event_at,
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
    const log = createEventLog(id, () => 0, path)
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
    log.observe({ kind: 'usage', tokens: 9, costUsd: null, per: 'call' }, 't5')
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
    const row = db().query('SELECT last_event_at FROM run WHERE record_id=?').get(id) as {
      last_event_at: string
    }
    expect(row.last_event_at).toBe('t5')
  })

  test('records redacted tool input and failed result text but no completed result text', () => {
    const id = addRun({ agent: 'goose', job: 'review-lens', status: 'running' })
    const path = runEventsPath(id)
    const log = createEventLog(id, () => 0, path)
    const secret = 'ghp_123456789012345678901234567890123456'
    log.observe(
      {
        kind: 'tool',
        title: 'shell',
        toolKind: 'execute',
        status: 'failed',
        input: `echo safe\necho ${secret}`,
        result: `permission denied\n${secret}`,
      },
      't1',
    )
    log.observe(
      { kind: 'tool', title: 'shell', status: 'completed', result: 'completed body' },
      't2',
    )
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(lines).toEqual([
      {
        ts: 't1',
        type: 'tool_call',
        kind: 'execute',
        title: 'shell',
        input: 'echo safe\necho [withheld: provider-prefix]',
      },
      {
        ts: 't1',
        type: 'tool_result',
        status: 'failed',
        bytes: Buffer.byteLength(`permission denied\n${secret}`),
        text: 'permission denied\n[withheld: provider-prefix]',
      },
      { ts: 't2', type: 'tool_call', title: 'shell' },
      { ts: 't2', type: 'tool_result', status: 'completed', bytes: 14 },
    ])
    expect(JSON.stringify(lines)).not.toContain(secret)
    expect(JSON.stringify(lines)).not.toContain('completed body')
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
    ).toEqual([{ kind: 'usage', tokens: 3, costUsd: null, per: 'turn' }])
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
        phase: 'update',
        title: 'task_list',
        toolKind: 'mcp',
        server: 'starship',
        status: 'completed',
        locations: undefined,
        target: undefined,
        result: undefined,
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
        phase: 'start',
        title: "sed -n '1,200p' probe.txt",
        toolKind: 'execute',
        status: 'in_progress',
        locations: undefined,
      },
      {
        kind: 'tool',
        phase: 'update',
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
  test('new note events round-trip UUIDs and labels while old numeric lines are skipped', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    appendRunEvent(id, {
      ts: '2026-10-09T12:00:00.000Z',
      type: 'note',
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidates: [{ recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' }],
    })
    appendFileSync(
      runEventsPath(id),
      `${JSON.stringify({ ts: '2026-10-09T12:01:00.000Z', type: 'note', noteId: 72, candidateIds: [9] })}\n`,
    )
    expect(peekRun(id, { events: 2 }).events).toEqual([
      { type: 'note', noteLabel: 'workshop#71', candidateLabels: ['workshop#8'] },
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
        appendRunEvent('0', { ts: new Date().toISOString(), type: 'text', text: 'x' }, bad),
      ).not.toThrow()
      expect(() =>
        appendRunEvent('0', { ts: new Date().toISOString(), type: 'text', text: 'x' }, blocker),
      ).not.toThrow()
      async function* broken() {
        yield { kind: 'text', text: 'one' }
        throw new Error('vendor stream broke')
      }
      await expect(teeTransportEvents(broken(), '0', () => 0)).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
