import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { EMPTY_QUOTA_READINGS } from './quota-readings.ts'
import { type TransportAgent, transportFor } from './transport.ts'
import { codexQuotaReadingsSince } from './transport-cli.ts'

async function resultLineUsage(billing: TransportAgent['billing']) {
  const resultLine = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 30, output_tokens: 12 },
    total_cost_usd: 1.25,
  })
  const agent: TransportAgent = {
    name: `${billing}-cli`,
    bin: process.execPath,
    defaultTransport: 'cli',
    billing,
    argv: () => ['-e', `console.log(${JSON.stringify(resultLine)})`],
    stdin: false,
    readsOut: false,
  }
  const outPath = join(dir, `cli-${billing}-result-line.txt`)
  const handle = await transportFor('cli').start({
    agent,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    prompt: 'prompt',
    outPath,
    startedAt: Date.now(),
  })
  const events = Array.fromAsync(handle.events())
  await handle.collect()
  rmSync(outPath, { force: true })
  return events
}

test('subscription CLI result line keeps usage tokens but removes cost', async () => {
  expect(await resultLineUsage('subscription')).toContainEqual({
    kind: 'usage',
    tokens: 42,
    costUsd: null,
    per: 'turn',
  })
})

test('metered CLI result line keeps usage cost', async () => {
  expect(await resultLineUsage('metered')).toContainEqual({
    kind: 'usage',
    tokens: 42,
    costUsd: 1.25,
    per: 'turn',
  })
})

test('subscription CLI reply cost is not persisted', async () => {
  const agent: TransportAgent = {
    name: 'subscription-cli',
    bin: process.execPath,
    defaultTransport: 'cli',
    billing: 'subscription',
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
    estimatedCostUsd: null,
    costSource: 'none',
  })
  rmSync(outPath, { force: true })
})

test('Codex quota observation does not read a symlinked rollout', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-quota-'))
  const codexHome = join(root, 'codex')
  const sessions = join(codexHome, 'sessions', '2026', '10', '28')
  const outside = join(root, 'outside.jsonl')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    outside,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 12, window_minutes: 10_080, resets_at: 1_793_774_132 },
        },
      },
    }),
  )
  symlinkSync(outside, join(sessions, 'rollout-linked.jsonl'))
  try {
    expect(codexQuotaReadingsSince(codexHome, new Map())).toEqual(EMPTY_QUOTA_READINGS)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
