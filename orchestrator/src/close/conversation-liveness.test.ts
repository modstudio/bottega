import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { aliveConversationTurns, liveCloseOutResult } from './conversation-liveness.ts'

test('close-out retains a live harness run tree', () => {
  const id = addRun({ agent: 'harness', job: 'implement', status: 'running', session: 'owner' })
  db().query("UPDATE run SET executor='harness',pid=NULL,agent_pid=NULL WHERE record_id=?").run(id)
  db()
    .query(
      `INSERT INTO session_seen (session_id,last_seen,ancestor_chain)
       VALUES ('owner',?,NULL)
       ON CONFLICT(session_id) DO UPDATE SET last_seen=excluded.last_seen`,
    )
    .run(nowIso())

  const live = aliveConversationTurns(id)
  expect(live.map((row) => row.record_id)).toEqual([id])
  expect(liveCloseOutResult(id, '/tmp/harness-tree', live)).toMatchObject({
    outcome: 'live',
    worktree: '/tmp/harness-tree',
  })
})
