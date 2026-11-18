import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { installRecordPool } from '../../test/fixtures/record-pool-injection.ts'
import { closeRecordPools, recordPool } from './record-pool.ts'

afterAll(closeRecordPools)

let originalNodeEnv: string | undefined
beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
})
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('one URL shares one pool until the pools are closed', async () => {
  const url = 'postgres://pool-probe@127.0.0.1:1/never-connected'
  const first = recordPool(url)
  expect(recordPool(url)).toBe(first)
  expect(recordPool(`${url}-other`)).not.toBe(first)
  expect(() => recordPool(url, 1)).toThrow('already holds max 10, not 1')
  await closeRecordPools()
  expect(recordPool(url)).not.toBe(first)
})

test('the test pool slot is ignored outside the test environment', async () => {
  const url = 'postgres://pool-slot@127.0.0.1:1/never-connected'
  const injected = {} as ReturnType<typeof recordPool>
  const restore = installRecordPool(url, injected)
  try {
    expect(recordPool(url)).not.toBe(injected)
  } finally {
    restore()
    await closeRecordPools()
  }
})
