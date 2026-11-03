import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { parseCodexQuotaReadings } from './codex-quota.ts'
import { CODEX_ROLLOUT_READ_CAP_BYTES, codexRolloutTextsSince } from './codex-rollout-files.ts'
import { EMPTY_QUOTA_READINGS } from './quota-readings.ts'
import { type TransportAgent, transportFor } from './transport.ts'
import {
  CLI_OUTPUT_CAPTURE_BYTES,
  codexRolloutEvidence,
  startCliStreamReaders,
} from './transport-cli.ts'

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

function tokenCountLine(usedPercent: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 10_080, resets_at: 1_793_774_132 },
      },
    },
  })
}

test('Codex quota observation reads only the turn-appended part of a nested rollout', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-quota-'))
  const codexHome = join(root, 'codex')
  const sessions = join(codexHome, 'sessions', '2026', '10', '28')
  const rollout = join(sessions, 'rollout-turn.jsonl')
  mkdirSync(sessions, { recursive: true })
  const earlierTurn = `${tokenCountLine(10)}\n`
  writeFileSync(rollout, `${earlierTurn}${tokenCountLine(12)}\n${tokenCountLine(15)}\n`)
  try {
    const offsets = new Map([[realpathSync(rollout), Buffer.byteLength(earlierTurn)]])
    expect(parseCodexQuotaReadings(codexRolloutTextsSince(codexHome, offsets).slice)).toEqual({
      quotaUsedPercentStart: 12,
      quotaUsedPercentEnd: 15,
      quotaWindowMinutes: 10_080,
      quotaResetsAt: 1_793_774_132,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an endless CLI stream stops at the capture ceiling and reports its overflow', async () => {
  const captureBytes = Math.floor(CLI_OUTPUT_CAPTURE_BYTES / 16_384)
  async function* endless(): AsyncGenerator<string> {
    for (;;) yield `${'y'.repeat(1024)}\n`
  }
  const overflows: Array<'stdout' | 'stderr'> = []
  const readers = startCliStreamReaders({
    stdout: endless(),
    stderr: endless(),
    codex: false,
    push: () => {},
    captureBytes,
    onCaptureOverflow: (stream) => overflows.push(stream),
  })

  const [stdout, stderr] = await Promise.all([readers.stdoutTask, readers.stderrTask])

  expect(stdout.overflow).toBe(true)
  expect(stderr.overflow).toBe(true)
  expect(Buffer.byteLength(stdout.text)).toBeLessThanOrEqual(captureBytes)
  expect(Buffer.byteLength(stderr.text)).toBeLessThanOrEqual(captureBytes)
  expect(overflows.sort()).toEqual(['stderr', 'stdout'])
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
    expect(parseCodexQuotaReadings(codexRolloutTextsSince(codexHome, new Map()).slice)).toEqual(
      EMPTY_QUOTA_READINGS,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A cap far below production, so a small fixture history exceeds it. */
const evidenceCapBytes = Math.floor(CODEX_ROLLOUT_READ_CAP_BYTES / 65_536)

const sessionMeta = (cliVersion: string) =>
  JSON.stringify({ type: 'session_meta', payload: { cli_version: cliVersion } })

function evidenceHome(): { root: string; sessions: string } {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-evidence-'))
  const sessions = join(root, 'sessions', '2026', '11', '02')
  mkdirSync(sessions, { recursive: true })
  return { root, sessions }
}

test('codexRolloutEvidence drops an over-cap slice and reports the overflow', () => {
  const { root, sessions } = evidenceHome()
  writeFileSync(
    join(sessions, 'rollout-over.jsonl'),
    `${sessionMeta('0.166.0')}\n${tokenCountLine(10)}\n${'x'.repeat(4_000)}\n`,
  )
  try {
    const evidence = codexRolloutEvidence(true, root, new Map(), evidenceCapBytes)

    expect(evidence.quotaReadings).toEqual(EMPTY_QUOTA_READINGS)
    expect(evidence.askExposure).toBeUndefined()
    expect(evidence.overflow?.message).toContain('CODEX_ROLLOUT_READ_CAP_BYTES')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('codexRolloutEvidence recovers a slice-missing CLI version from a bounded head', () => {
  const { root, sessions } = evidenceHome()
  const meta = `${sessionMeta('0.166.0')}\n`
  const rollout = join(sessions, 'rollout-version.jsonl')
  writeFileSync(rollout, `${meta}${tokenCountLine(10)}\n`)
  try {
    const offsets = new Map([[realpathSync(rollout), Buffer.byteLength(meta)]])
    const evidence = codexRolloutEvidence(true, root, offsets)

    expect(evidence.overflow).toBeNull()
    expect(evidence.askExposure?.cliVersion).toBe('0.166.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('codexRolloutEvidence keeps the slice CLI version over a differing file head', () => {
  const { root, sessions } = evidenceHome()
  const headMeta = `${sessionMeta('0.111.0')}\n`
  const filler = 'x'.repeat(70_000)
  const rollout = join(sessions, 'rollout-slice-version.jsonl')
  writeFileSync(rollout, `${headMeta}${filler}${sessionMeta('0.222.0')}\n${tokenCountLine(10)}\n`)
  try {
    const offsets = new Map([[realpathSync(rollout), Buffer.byteLength(`${headMeta}${filler}`)]])
    const evidence = codexRolloutEvidence(true, root, offsets)

    // The head holds 0.111.0, so a heads-derived version would differ.
    expect(evidence.askExposure?.cliVersion).toBe('0.222.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
