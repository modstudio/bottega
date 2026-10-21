import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { type TransportAgent, transportFor } from './transport.ts'

test('CLI reply cost is persisted only as an estimate', async () => {
  const agent: TransportAgent = {
    name: 'subscription-cli',
    bin: process.execPath,
    defaultTransport: 'cli',
    argv: () => ['-e', 'console.log("reply")'],
    stdin: false,
    readsOut: false,
    parseReply: () => ({ text: 'reply', tokens: 42, costUsd: 1.25 }),
  }
  const outPath = join(dir, 'cli-cost-reply.txt')
  const handle = await transportFor('cli').start({
    agent,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    prompt: 'prompt',
    outPath,
    startedAt: Date.now(),
  })

  const result = await handle.collect()

  expect(result.costUsd).toBeNull()
  expect(result.vendorUsage).toEqual({
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: 1.25,
    costSource: 'estimated',
  })
  rmSync(outPath, { force: true })
})
