import { expect, test } from 'bun:test'
import { createWorkRouter } from './work.ts'

test('setBody maps a stale compare-and-swap to CONFLICT and does not retry', async () => {
  let body = 'current'
  let writes = 0
  const router = createWorkRouter({
    strip: (() => ({})) as never,
    view: (async () => ({})) as never,
    setTaskBody: (async (_key: string, _scope: unknown, next: string, expectedVersion: string) => {
      writes++
      if (expectedVersion !== 'current-version') {
        throw new Error(`task DEV-1 body changed since version ${expectedVersion}`)
      }
      body = next
      return {} as never
    }) as never,
  })
  const caller = router.createCaller({})
  await caller.setBody({
    key: 'DEV-1',
    scope: {},
    body: 'saved',
    expectedVersion: 'current-version',
  })
  expect(body).toBe('saved')
  await expect(
    caller.setBody({ key: 'DEV-1', scope: {}, body: 'stale', expectedVersion: 'old-version' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(body).toBe('saved')
  expect(writes).toBe(2)
})
