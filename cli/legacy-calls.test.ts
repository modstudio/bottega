import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyCallCounts, recordLegacyCall } from './legacy-calls.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-calls-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('legacy call counts retain source and first and last sightings', () => {
  const env = { BOTTEGA_STATE_HOME: root, CLAUDE_CODE_SESSION_ID: 'session-one' }
  recordLegacyCall('orch', ['result', '42', '--json'], 'external', env)
  recordLegacyCall('orch', ['result', '42'], 'external', env)
  const rows = legacyCallCounts(undefined, env)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ command: 'orch result', source: 'external', count: 2 })
  expect(rows[0]!.firstSeen <= rows[0]!.lastSeen).toBeTrue()
})

test('legacy call counts preserve genuine nested commands', () => {
  const env = { BOTTEGA_STATE_HOME: root }
  recordLegacyCall('hub', ['task', 'show', 'DEV-1311'], 'internal', env)
  recordLegacyCall('hub', ['task', 'show', 'DEV-1312'], 'internal', env)
  expect(legacyCallCounts(undefined, env)).toMatchObject([
    { command: 'hub task show', source: 'internal', count: 2 },
  ])
})
