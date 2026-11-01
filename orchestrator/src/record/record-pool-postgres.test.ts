import { afterAll, describe, expect, test } from 'bun:test'
import { closeRecordPools, recordPool } from './record-pool.ts'

const url = process.env.BOTTEGA_TEST_RECORD_POOL_URL

afterAll(closeRecordPools)

const realPostgres = url ? describe : describe.skip
realPostgres('record pool against real Postgres', () => {
  test('a failed tenant transaction returns a clean pooled connection', async () => {
    const pool = recordPool(url!, 1)
    await expect(
      pool.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true)`
        throw new Error('rollback probe')
      }),
    ).rejects.toThrow('rollback probe')

    const rows = await pool`SELECT current_setting('app.user_id', true) AS setting`
    expect(rows[0]?.setting).toBe('')
  })
})
