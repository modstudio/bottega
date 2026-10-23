import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import {
  BOARD_CACHE_OWNER_KEY,
  BOARD_REFRESH_OUTCOME_KEY,
  refreshHostedBoard,
  takeHostedBoardVerificationTransition,
} from './board-hosted-cache.ts'
import { BOARD_UNVERIFIED_NOTICE_AFTER_MS } from './board-hosted-verification-policy.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const verifiedAt = '2026-10-05T12:00:00.000Z'

beforeEach(() => {
  db().query('DELETE FROM hosted_board_message_cache').run()
  db().query("DELETE FROM schema_meta WHERE key LIKE 'board_hosted_%'").run()
})

test('verification transition announces a persistent episode and recovery once, and owner reset clears it', async () => {
  const database = db()
  const verifiedAtMs = Date.parse(verifiedAt)
  const noticeAt = verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS
  const putMeta = database.query('INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)')
  putMeta.run(BOARD_HOSTED_ADOPTED_KEY, '1')
  putMeta.run(BOARD_CACHE_OWNER_KEY, userId)
  putMeta.run('board_hosted_signed_in_user', userId)
  putMeta.run('board_hosted_verified_at', verifiedAt)
  putMeta.run('board_hosted_refresh_at', new Date(noticeAt).toISOString())
  putMeta.run(BOARD_REFRESH_OUTCOME_KEY, 'failed: hosted board refresh budget spent')

  expect(takeHostedBoardVerificationTransition(database, noticeAt)).toContain(
    'Hosted board cache is unverified',
  )
  expect(takeHostedBoardVerificationTransition(database, noticeAt + 1)).toBeNull()

  putMeta.run('board_hosted_verified_at', new Date(noticeAt + 2).toISOString())
  putMeta.run(BOARD_REFRESH_OUTCOME_KEY, 'success')
  expect(takeHostedBoardVerificationTransition(database, noticeAt + 2)).toContain(
    'Hosted board cache is verified again',
  )
  expect(takeHostedBoardVerificationTransition(database, noticeAt + 3)).toBeNull()

  putMeta.run(BOARD_REFRESH_OUTCOME_KEY, 'failed: hosted board refresh budget spent')
  expect(
    takeHostedBoardVerificationTransition(
      database,
      noticeAt + 2 + BOARD_UNVERIFIED_NOTICE_AFTER_MS,
    ),
  ).toContain('Hosted board cache is unverified')

  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { BOTTEGA_RECORD_API_URL: 'x' },
    database,
    client: {
      ...createMemoryRecordApiClient(),
      listBoardChanges: async () => ({
        userId: newRecordId(),
        items: [],
        highestRevision: null,
      }),
    },
  })
  expect(
    database
      .query('SELECT value FROM schema_meta WHERE key=?')
      .get('board_hosted_monitor_unverified_announced'),
  ).toBeNull()
})
