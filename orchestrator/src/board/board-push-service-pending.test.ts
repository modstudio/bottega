import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { pendingBoardDelivery } from './board-push-service.ts'
import { acknowledgeNotice, postNotice } from './board-service.ts'

test('pending acknowledgement resolution combines local and hosted cache and excludes acknowledged or unaddressed notices', async () => {
  const clock = Date.parse('2026-10-07T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('push-reader','claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const local = postNotice(
    {
      audience: 'project:push-project',
      title: 'Local',
      body: 'Local body',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock,
  )
  const olderLocal = postNotice(
    {
      audience: 'project:push-project',
      title: 'Older local',
      body: 'Do not ask this reader to acknowledge.',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock - 2_000,
  )
  const olderStandingLocal = postNotice(
    {
      audience: 'project:push-project',
      title: 'Older standing local',
      body: 'Acknowledge this standing rule.',
      ackRequired: true,
      purpose: 'standing',
    },
    {},
    clock - 2_000,
  )
  const acknowledged = postNotice(
    {
      audience: 'project:push-project',
      title: 'Done',
      body: 'Done body',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock + 1,
  )
  acknowledgeNotice(acknowledged.id, { CLAUDE_CODE_SESSION_ID: 'push-reader' }, clock + 2)
  const setMeta = db().query(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
  setMeta.run('board_hosted_cache_owner', 'user-1')
  setMeta.run('board_hosted_signed_in_user', 'user-1')
  const hosted = {
    id: '01990000-0000-7000-8000-000000000111',
    kind: 'notice',
    threadRootId: null,
    title: 'Hosted',
    body: 'Hosted body',
    audience: 'project:push-project',
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: null,
      runId: null,
    },
    senderTags: [],
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(),
    withdrawnAt: null,
    state: 'open',
    acceptedReplyId: null,
    acceptedBy: null,
    acceptedAt: null,
    noteId: null,
    notePendingError: null,
    revision: '1',
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    authorUserId: 'user-1',
    authorSession: null,
    ackRequired: true,
    purpose: 'request',
    ackDeadline: new Date(clock + 30_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))
  const olderHosted = {
    ...hosted,
    id: '01990000-0000-7000-8000-000000000112',
    title: 'Older hosted',
    createdAt: new Date(clock - 2_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(olderHosted.id, olderHosted.kind, null, olderHosted.revision, JSON.stringify(olderHosted))
  const olderStandingHosted = {
    ...olderHosted,
    id: '01990000-0000-7000-8000-000000000113',
    title: 'Older standing hosted',
    purpose: 'standing',
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(
      olderStandingHosted.id,
      olderStandingHosted.kind,
      null,
      olderStandingHosted.revision,
      JSON.stringify(olderStandingHosted),
    )

  const pending = await pendingBoardDelivery({
    session: 'push-reader',
    budgetMs: 1,
    clock: clock + 3,
  })
  expect(pending.delivery.map((notice) => notice.id).sort()).toEqual(
    [String(local.id), String(olderStandingLocal.id), hosted.id, olderStandingHosted.id].sort(),
  )
  expect(pending.pendingAcknowledgements.map((notice) => notice.id).sort()).toEqual(
    [String(local.id), String(olderStandingLocal.id), hosted.id, olderStandingHosted.id].sort(),
  )
  expect(pending.delivery.map((notice) => notice.id)).not.toContain(String(olderLocal.id))
  expect(pending.pendingAcknowledgements.map((notice) => notice.id)).not.toContain(olderHosted.id)
})
