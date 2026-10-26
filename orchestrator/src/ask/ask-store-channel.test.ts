import { expect, test } from 'bun:test'
import { serveAsk } from './ask.ts'

/**
 * The declaration is the whole reason a worker-classified ask server may write the store, and
 * a store opened before it opens read-only for the life of the process. Nothing spawns here:
 * the two store-facing steps are what the entry is asked for.
 */
test('the ask-server entry declares the one broker channel before anything opens the store', async () => {
  const ordered: string[] = []
  const askUrl = process.env.BOTTEGA_ASK_URL
  delete process.env.BOTTEGA_ASK_URL
  try {
    await expect(
      serveAsk({
        declareBrokerChannel: () => {
          ordered.push('declare')
        },
        openStore: () => {
          ordered.push('open')
          throw new Error('the store open is where this test stops')
        },
      }),
    ).rejects.toThrow('the store open is where this test stops')
  } finally {
    if (askUrl !== undefined) process.env.BOTTEGA_ASK_URL = askUrl
  }
  expect(ordered).toEqual(['declare', 'open'])
})
