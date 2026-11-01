import { afterAll, expect, test } from 'bun:test'
import { closeRecordPools, recordPool } from './record-pool.ts'

afterAll(closeRecordPools)

test('one URL shares one pool until the pools are closed', async () => {
  const url = 'postgres://pool-probe@127.0.0.1:1/never-connected'
  const first = recordPool(url)
  expect(recordPool(url)).toBe(first)
  expect(recordPool(`${url}-other`)).not.toBe(first)
  await closeRecordPools()
  expect(recordPool(url)).not.toBe(first)
})
