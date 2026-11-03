import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_ROLLOUT_HEAD_BYTES,
  CODEX_ROLLOUT_READ_CAP_BYTES,
  codexRolloutTextsSince,
  codexRolloutVersionHeads,
} from './codex-rollout-files.ts'

const meta = JSON.stringify({
  type: 'session_meta',
  payload: { cli_version: '0.166.0' },
})

function rolloutHome(): { root: string; sessions: string } {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-rollout-cap-'))
  const sessions = join(root, 'sessions', '2026', '11', '02')
  mkdirSync(sessions, { recursive: true })
  return { root, sessions }
}

/** A cap far below production, so each fixture history is large relative to it. */
const smallCapBytes = Math.floor(CODEX_ROLLOUT_READ_CAP_BYTES / 65_536)

/** Filler long enough that its byte size is the file's byte size. */
function filler(bytes: number): string {
  return 'x'.repeat(bytes)
}

test('an unchanged rollout history yields no slice and reads no old bytes', () => {
  const { root, sessions } = rolloutHome()
  const history = `${meta}\n${filler(200_000)}\n`
  const rollout = join(sessions, 'rollout-idle.jsonl')
  writeFileSync(rollout, history)
  try {
    const offsets = new Map([[realpathSync(rollout), Buffer.byteLength(history)]])
    const texts = codexRolloutTextsSince(root, offsets, smallCapBytes)

    expect(texts.slice).toBe('')
    // The 200 KB of history never entered the cap accounting, so a cap far
    // smaller than the history is not an overflow for this turn.
    expect(texts.overflow).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a rollout home over the cap reports the overflow instead of text', () => {
  const { root, sessions } = rolloutHome()
  const rollout = join(sessions, 'rollout-grown.jsonl')
  writeFileSync(rollout, `${meta}\n${filler(4_000)}\n`)
  try {
    const texts = codexRolloutTextsSince(root, new Map(), smallCapBytes)

    expect(texts.slice).toBe('')
    expect(texts.overflow?.capBytes).toBe(smallCapBytes)
    expect(texts.overflow?.attemptedBytes).toBeGreaterThan(smallCapBytes)
    expect(texts.overflow?.message).toContain('CODEX_ROLLOUT_READ_CAP_BYTES')
    expect(texts.overflow?.message).toContain('orchestrator/src/transport/codex-rollout-files.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI version is still recovered from a bounded file head', () => {
  const { root, sessions } = rolloutHome()
  const rollout = join(sessions, 'rollout-version.jsonl')
  writeFileSync(rollout, `${meta}\n${filler(4_000)}\n`)
  try {
    const heads = codexRolloutVersionHeads(root)

    expect(heads).toContain('"cli_version":"0.166.0"')
    expect(Buffer.byteLength(heads)).toBeLessThanOrEqual(CODEX_ROLLOUT_HEAD_BYTES)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
