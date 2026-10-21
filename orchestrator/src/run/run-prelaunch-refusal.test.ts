import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { refuseUnstartedRun } from './run-prelaunch-refusal.ts'

test('an MCP prelaunch refusal publishes the child and rolls up its root once', async () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const child = addRun({
    agent: 'codex',
    job: 'review-lens',
    status: 'running',
    parent: root,
    turn: 2,
  })
  let resets = 0

  await expect(
    refuseUnstartedRun({
      runId: child,
      started: Date.now() - 20,
      why: 'required MCP grammar was not available',
      mcpError: 'required MCP grammar was not available',
      resetSandbox: async () => {
        resets += 1
      },
    }),
  ).rejects.toThrow('required MCP grammar was not available')

  expect(resets).toBe(1)
  expect(
    db()
      .query('SELECT status, failure_kind, error, mcp_error FROM run WHERE record_id=?')
      .get(child),
  ).toEqual({
    status: 'failed',
    failure_kind: 'mcp_unverified',
    error: 'required MCP grammar was not available',
    mcp_error: 'required MCP grammar was not available',
  })
  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(root),
  ).toEqual({
    status: 'failed',
    failure_kind: 'mcp_unverified',
    error: 'required MCP grammar was not available',
  })
  expect(
    db()
      .query("SELECT row_id FROM outbox WHERE row_id IN (?,?) AND kind='run' ORDER BY row_id")
      .all(root, child),
  ).toEqual([{ row_id: root }, { row_id: child }].sort((a, b) => a.row_id.localeCompare(b.row_id)))
})
