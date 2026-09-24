import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './database/db.ts'
import { createEventLog, eventsFromVendorLine, idleLabel, runEventsPath } from './events.ts'

describe('vendor event log', () => {
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

  test('idleLabel is silent until the threshold and then prints idle Nm', () => {
    const started = '2026-09-07T00:00:00.000Z'
    const last = '2026-09-07T00:01:00.000Z'
    const now = Date.parse('2026-09-07T00:06:00.000Z')
    expect(idleLabel(last, started, now, 5 * 60_000)).toBe('idle 5m')
    expect(idleLabel(last, started, now, 6 * 60_000)).toBeNull()
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
