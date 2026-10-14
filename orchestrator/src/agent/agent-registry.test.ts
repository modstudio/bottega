import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { type AgentRow, addAgent, rowAgent } from './agent-registry.ts'

function codexRow(probeResult: unknown): AgentRow {
  const row = db().query("SELECT * FROM agent WHERE name = 'codex'").get() as AgentRow
  return { ...row, probe_result: JSON.stringify(probeResult) }
}

test('a probe result with no ok verdict is unknown', () => {
  expect(rowAgent(codexRow({ source: 'legacy' })).probePassed).toBeNull()
})

test('an explicit null probe verdict is unknown', () => {
  expect(rowAgent(codexRow({ ok: null })).probePassed).toBeNull()
})

test('an explicit false probe verdict is not passed', () => {
  expect(rowAgent(codexRow({ ok: false })).probePassed).toBe(false)
})

test('an explicit true probe verdict is passed', () => {
  expect(rowAgent(codexRow({ ok: true })).probePassed).toBe(true)
})

test('a registered agent is created with a version-seven record id', () => {
  addAgent('identity-fixture', {
    harness: 'codex',
    backend: 'vendor',
    model: 'fixture',
  })
  const row = db().query("SELECT record_id FROM agent WHERE name='identity-fixture'").get() as {
    record_id: string
  }
  expect(row.record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
})
