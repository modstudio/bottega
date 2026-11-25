import { expect, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardPost, boardStatus, boardThread } from './board-operations.ts'

test('machine writes and their number and UUID reads stay local after adoption', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const client = createMemoryRecordApiClient()
  const env = { BOTTEGA_RECORD_API_URL: 'https://record.test' }
  const local = await boardPost(
    { audience: 'machine:host', title: 'Machine', body: 'local' },
    { env, client },
  )
  expect(local.recordId).toMatch(/^[0-9a-f-]{36}$/)
  await expect(boardThread(local.recordId, { env, client })).resolves.toMatchObject({
    root: { recordId: local.recordId },
  })
  await expect(boardStatus(local.recordId, { env, client })).resolves.toMatchObject({
    message: { recordId: local.recordId },
  })
  await expect(boardStatus(String(local.number), { env, client })).resolves.toMatchObject({
    message: { recordId: local.recordId },
  })
})
