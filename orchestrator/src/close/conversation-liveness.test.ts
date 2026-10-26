import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { recordedOwnerProcess } from '../run/run-owner-session-liveness.ts'
import { aliveConversationTurns, liveCloseOutResult } from './conversation-liveness.ts'

test('close-out retains a live harness run tree', () => {
  const id = addRun({ agent: 'harness', job: 'implement', status: 'running', session: 'owner' })
  db()
    .query(
      "UPDATE run SET executor='harness',pid=NULL,agent_pid=NULL,harness_wall_bound_ms=2700000,started_at=? WHERE record_id=?",
    )
    .run(nowIso(), id)
  db()
    .query(
      `INSERT INTO session_seen (session_id,last_seen,ancestor_chain)
       VALUES ('owner',?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen=excluded.last_seen, ancestor_chain=excluded.ancestor_chain`,
    )
    .run(nowIso(), null)

  const live = aliveConversationTurns(id)
  expect(live.map((row) => row.record_id)).toEqual([id])
  expect(liveCloseOutResult(id, '/tmp/harness-tree', live)).toMatchObject({
    outcome: 'live',
    worktree: '/tmp/harness-tree',
  })
})

test('a recorded live owner process survives an old session stamp', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO session_seen (session_id,last_seen,ancestor_chain)
       VALUES ('process-owner',?,?)`,
    )
    .run('2026-10-26T10:00:00.000Z', JSON.stringify([{ pid: 4321, startTime: 'owner-start' }]))
  expect(
    recordedOwnerProcess(db(), 'process-owner', now, () => ({
      alive: true,
      startTime: 'owner-start',
    })),
  ).toBe('live')
})
