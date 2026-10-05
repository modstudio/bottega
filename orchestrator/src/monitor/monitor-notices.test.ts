import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient, installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  claimMonitorNoticesWithHosted,
  markMonitorNoticesDeliveredWithHosted,
} from './monitor-notices.ts'

afterEach(() => installRecordApiClient(null))

test('monitor notice and interrupt claims emit hosted beside local once with a failed-refresh warning', async () => {
  const session = 'monitor-hosted-reader'
  const userId = newRecordId()
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('board_hosted_signed_in_user', userId)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project','/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', '2098-01-01T00:00:00.000Z')
  const local = postNotice(
    { audience: `session:${session}`, title: 'Local interrupt', body: 'local monitor body', ackRequired: true },
    {},
    Date.parse('2026-10-05T12:00:00.000Z'),
  )
  const hosted: HostedBoardMessage = {
    id: newRecordId(), kind: 'notice', threadRootId: null, title: 'Hosted interrupt', body: 'hosted monitor body',
    audience: `session:${session}`,
    origin: { kind: 'operator', session: null, harness: null, project: 'monitor-project', runId: null },
    senderTags: [], createdAt: '2026-10-05T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    withdrawnAt: null, state: 'open', acceptedReplyId: null, acceptedBy: null, acceptedAt: null,
    noteId: null, notePendingError: null, revision: '1', scopeProjectIds: [], recipientUserIds: [],
    claimId: null, authorUserId: userId, authorSession: null, ackRequired: true, ackDeadline: null,
  }
  db().query('INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)')
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => { throw new Error('monitor refresh offline') },
    putBoardReceipt: async () => { throw new Error('receipt offline') },
  })
  const delivery = await claimMonitorNoticesWithHosted(session)
  expect(delivery.notices.map((row) => row.noticeId)).toEqual([`board:${local.id}`, `board:${hosted.id}`])
  expect(delivery.warning).toContain('monitor refresh offline')
  await markMonitorNoticesDeliveredWithHosted(session, delivery.notices.map((row) => row.noticeId))
  expect((await claimMonitorNoticesWithHosted(session)).notices).toEqual([])
})
