import { expect, test } from 'bun:test'
import { processMemo } from './process-memo.ts'

test('concurrent gets share one load', async () => {
  let loads = 0
  let finish!: (value: string) => void
  const memo = processMemo(
    () => {
      loads += 1
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
    { maxAgeMs: 100 },
  )

  const reads = [memo.get(), memo.get(), memo.get()]
  expect(loads).toBe(1)
  finish('shared')
  expect(await Promise.all(reads)).toEqual(['shared', 'shared', 'shared'])
})

test('reloads after the age measured from when loading began expires', async () => {
  let now = 10
  let loads = 0
  const memo = processMemo(
    async () => {
      loads += 1
      return loads
    },
    { maxAgeMs: 100, now: () => now },
  )

  expect(await memo.get()).toBe(1)
  now = 109
  expect(await memo.get()).toBe(1)
  now = 110
  expect(await memo.get()).toBe(2)
})

test('does not keep a rejected load', async () => {
  let rejectedLoads = 0
  const rejected = processMemo(
    async () => {
      rejectedLoads += 1
      if (rejectedLoads === 1) throw new Error('fixture rejection')
      return 'kept'
    },
    { maxAgeMs: 100 },
  )
  await expect(rejected.get()).rejects.toThrow('fixture rejection')
  expect(await rejected.get()).toBe('kept')
  expect(rejectedLoads).toBe(2)
})

test('clearIf leaves pending and non-matching values, then drops a matching value', async () => {
  let loads = 0
  let finish!: (value: string) => void
  const memo = processMemo(
    () => {
      loads += 1
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
    { maxAgeMs: 100 },
  )

  const pending = memo.get()
  memo.clearIf((value) => value === 'fake-value-a')
  expect(memo.get()).toBe(pending)
  finish('fake-value-a')
  expect(await pending).toBe('fake-value-a')

  memo.clearIf((value) => value === 'fake-value-b')
  expect(await memo.get()).toBe('fake-value-a')
  expect(loads).toBe(1)

  memo.clearIf((value) => value === 'fake-value-a')
  const reloaded = memo.get()
  expect(loads).toBe(2)
  finish('fake-value-b')
  expect(await reloaded).toBe('fake-value-b')
})
