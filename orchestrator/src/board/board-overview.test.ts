import { beforeEach, expect, test } from 'bun:test'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { BOARD_CACHE_OWNER_KEY } from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  type BoardOverviewEntry,
  boardOverview,
  type GatheredBoardOverviewRow,
  listBoardOverview,
} from './board-overview.ts'
import { postNotice, readNotices } from './board-service.ts'
import type { BoardThreadState } from './board-thread-policy.ts'

const clock = Date.parse('2026-10-05T12:00:00.000Z')
const noRecordEnv = {
  [CONFIG_HOME_ENV]: '/definitely-missing-config',
  [HARNESS_ENV_FILE_ENV]: '',
}
const origin = {
  kind: 'architect',
  session: 'overview-author',
  harness: 'claude',
  project: 'overview-project',
  runId: null,
}

function entry(
  id: string,
  kind: 'notice' | 'question',
  createdAt: string,
  state: BoardThreadState,
  acceptedReplyId: string | null = null,
): BoardOverviewEntry {
  const base = {
    id,
    title: `${kind} ${id}`,
    audience: 'operator',
    origin,
    senderTags: [],
    createdAt,
    expiresAt: '2026-10-06T12:00:00.000Z',
    withdrawnAt: state === 'withdrawn' ? createdAt : null,
    ackRequired: false,
    ackDeadline: null,
    state,
    reached: 1,
    acknowledged: 0,
    unacknowledged: [],
    store: 'local' as const,
  }
  return kind === 'question'
    ? { ...base, kind, replyCount: acceptedReplyId ? 1 : 0, acceptedReplyId }
    : { ...base, kind }
}

beforeEach(() => {
  db().query('DELETE FROM board_message').run()
  db().query('DELETE FROM hosted_board_receipt_cache').run()
  db().query('DELETE FROM hosted_board_message_tag_cache').run()
  db().query('DELETE FROM hosted_board_message_cache').run()
  db().query("DELETE FROM schema_meta WHERE key LIKE 'board_hosted_%'").run()
  db().query("DELETE FROM presence WHERE session_id LIKE 'overview-%'").run()
})

test('the pure overview applies kind, open, ended filters and newest-first opaque-id order', () => {
  const messages = [
    entry('local-1', 'notice', '2026-10-05T10:00:00.000Z', 'open'),
    entry('z-hosted', 'question', '2026-10-05T11:00:00.000Z', 'open'),
    entry('a-local', 'question', '2026-10-05T11:00:00.000Z', 'open'),
    entry('accepted', 'question', '2026-10-05T12:00:00.000Z', 'accepted', 'reply-1'),
    entry('expired', 'question', '2026-10-05T09:00:00.000Z', 'expired'),
    entry('withdrawn', 'notice', '2026-10-05T08:00:00.000Z', 'withdrawn'),
  ]
  const rows: GatheredBoardOverviewRow[] = messages.map((message) => ({
    message,
    ended: message.state === 'expired' || message.state === 'withdrawn',
  }))

  expect(boardOverview(rows).map((row) => row.id)).toEqual([
    'accepted',
    'z-hosted',
    'a-local',
    'local-1',
  ])
  expect(boardOverview(rows, { kind: 'notice' }).map((row) => row.id)).toEqual(['local-1'])
  expect(boardOverview(rows, { open: true }).map((row) => row.id)).toEqual(['z-hosted', 'a-local'])
  expect(boardOverview(rows, { open: true, includeEnded: true }).map((row) => row.id)).toEqual([
    'z-hosted',
    'a-local',
    'expired',
  ])
  expect(boardOverview(rows, { includeEnded: true }).map((row) => row.id)).toEqual([
    'accepted',
    'z-hosted',
    'a-local',
    'local-1',
    'expired',
    'withdrawn',
  ])
})

test('an unadopted overview ignores caller audience and stamps no delivery receipt', async () => {
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('overview-addressed','claude','architect','machine','overview-project','/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.000Z')
  const posted = postNotice(
    { audience: 'session:overview-addressed', title: 'Addressed elsewhere', body: 'body' },
    {},
    clock,
  )

  const listed = await listBoardOverview(
    {},
    {
      env: { ...noRecordEnv, CLAUDE_CODE_SESSION_ID: 'overview-caller' },
      clock,
    },
  )
  expect(listed.messages.map((row) => row.id)).toContain(String(posted.id))
  expect(listed.warning).toBeNull()
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(posted.id, 'overview-addressed'),
  ).toEqual({ delivered_at: null })
  expect(
    readNotices(false, { CLAUDE_CODE_SESSION_ID: 'overview-addressed' }, clock).map(
      (row) => row.id,
    ),
  ).toEqual([posted.id])
})

test('an adopted overview combines local and cached roots with null hosted reach and warning', async () => {
  const local = postNotice(
    { audience: 'machine:this', title: 'Machine local', body: 'body' },
    {},
    clock,
  )
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const userId = newRecordId()
  const hosted: HostedBoardMessage = {
    id: newRecordId(),
    kind: 'question',
    threadRootId: null,
    title: 'Cached hosted',
    body: 'body',
    audience: 'operator',
    origin,
    senderTags: [{ kind: 'topic', value: 'mcp' }],
    createdAt: '2026-10-05T12:01:00.000Z',
    expiresAt: '2026-10-06T12:00:00.000Z',
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
    authorUserId: userId,
    authorSession: origin.session,
    ackRequired: false,
    ackDeadline: null,
  }
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_CACHE_OWNER_KEY, userId)
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', userId)
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))

  const listed = await listBoardOverview(
    {},
    {
      env: { ORCH_RECORD_API_URL: 'https://record.test' },
      clock,
      client: {
        ...createMemoryRecordApiClient(),
        listBoardChanges: async () => {
          throw new Error('overview refresh offline')
        },
      },
    },
  )
  expect(listed.messages.map((row) => row.id)).toEqual([hosted.id, String(local.id)])
  expect(listed.messages[0]).toMatchObject({
    id: hosted.id,
    store: 'hosted',
    reached: 0,
    acknowledged: 0,
    unacknowledged: [],
    replyCount: 0,
  })
  expect(listed.messages[1]).toMatchObject({ id: String(local.id), store: 'local', reached: 0 })
  expect(listed.warning).toContain('overview refresh offline')
})
