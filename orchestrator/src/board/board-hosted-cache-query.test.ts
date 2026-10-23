import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { BOARD_CACHE_OWNER_KEY, claimCachedHosted } from './board-hosted-cache.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const createdAt = '2026-10-05T12:00:00.000Z'

const message = (index: number): HostedBoardMessage => ({
  id: newRecordId(),
  kind: 'notice',
  threadRootId: null,
  title: `cached ${index}`,
  body: 'cached body',
  audience: 'session:cache-reader',
  origin: {
    kind: 'architect',
    session: 'author',
    harness: 'claude',
    project: 'cache-project',
    projectStored: true,
    runId: null,
  },
  senderTags: [],
  createdAt,
  expiresAt: '2027-10-05T12:00:00.000Z',
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
  authorSession: 'author',
  ackRequired: false,
  ackDeadline: null,
})

test('hosted claims batch tag and reader receipt reads independent of cache size', () => {
  const database = db()
  database
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,cwd,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','cache-project','/tmp',?,?)`,
    )
    .run('cache-reader', createdAt, createdAt)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?),(?,?)')
    .run(BOARD_CACHE_OWNER_KEY, userId, 'board_hosted_signed_in_user', userId)
  const putMessage = database.query(
    'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
  )
  const putTag = database.query(
    'INSERT INTO hosted_board_message_tag_cache(message_id,kind,value,origin) VALUES (?,?,?,?)',
  )
  const putReceipt = database.query(
    `INSERT INTO hosted_board_receipt_cache
     (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
     VALUES (?,?,1,?,NULL,0)`,
  )
  const insert = (count: number) => {
    for (let index = 0; index < count; index++) {
      const cached = message(index)
      putMessage.run(cached.id, cached.kind, null, cached.revision, JSON.stringify(cached))
      putTag.run(cached.id, 'task', `DEV-${index}`, 'sender')
      if (index > 0) putReceipt.run(cached.id, 'cache-reader', createdAt)
    }
  }
  const queryCount = () => {
    let count = 0
    const instrumented = new Proxy(database, {
      get(target, property) {
        if (property === 'query')
          return (sql: string) => {
            count++
            return target.query(sql)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Database
    claimCachedHosted('cache-reader', false, Date.parse('2026-10-05T12:02:00.000Z'), instrumented)
    return count
  }

  insert(1)
  const singleMessageQueries = queryCount()
  insert(99)
  expect(queryCount()).toBe(singleMessageQueries)
})
