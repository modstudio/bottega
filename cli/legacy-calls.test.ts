import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyCallCounts } from './legacy-calls.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-calls-'))
  mkdirSync(join(root, 'orchestrator'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeCalls(rows: Record<string, unknown>[]): void {
  writeFileSync(
    join(root, 'orchestrator', 'legacy-calls.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
  )
}

test('legacy call counts retain source and first and last sightings', () => {
  const env = { BOTTEGA_STATE_HOME: root, CLAUDE_CODE_SESSION_ID: 'session-one' }
  writeCalls([
    {
      time: '2026-01-01T00:00:00.000Z',
      oldName: 'orch',
      tokens: ['result'],
      cwd: '/tmp',
      harnessSessionId: 'session-one',
      source: 'external',
    },
    {
      time: '2026-01-01T00:01:00.000Z',
      oldName: 'orch',
      tokens: ['result'],
      cwd: '/tmp',
      harnessSessionId: 'session-one',
      source: 'external',
    },
  ])
  const rows = legacyCallCounts(undefined, env)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ command: 'orch result', source: 'external', count: 2 })
  expect(rows[0]!.firstSeen <= rows[0]!.lastSeen).toBeTrue()
})

test('legacy call counts preserve genuine nested commands', () => {
  const env = { BOTTEGA_STATE_HOME: root }
  writeCalls([
    {
      time: '2026-01-01T00:00:00.000Z',
      oldName: 'hub',
      tokens: ['task', 'show'],
      cwd: '/tmp',
      harnessSessionId: null,
      source: 'internal',
    },
    {
      time: '2026-01-01T00:01:00.000Z',
      oldName: 'hub',
      tokens: ['task', 'show'],
      cwd: '/tmp',
      harnessSessionId: null,
      source: 'internal',
    },
  ])
  expect(legacyCallCounts(undefined, env)).toMatchObject([
    { command: 'hub task show', source: 'internal', count: 2 },
  ])
})
