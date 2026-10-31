// Tests codex-ask-exposure.ts: observed rollout parsing, turn slicing, and event construction.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  askExposureEvent,
  codexAskExposureFromTexts,
  parseCodexAskExposure,
} from './codex-ask-exposure.ts'
import { codexRolloutTextsSince } from './codex-rollout-files.ts'

const meta = JSON.stringify({ type: 'session_meta', payload: { cli_version: '0.166.0' } })
const tools = (offered: unknown[]) =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'additional_tools', id: '1', role: 'system', tools: offered },
  })
const namespace = (name: string, names: string[]) => ({
  type: 'namespace',
  name,
  tools: names.map((tool) => ({ type: 'custom', name: tool })),
})

test('recognized functions.exec rollout is code-mode with its CLI version', () => {
  expect(
    parseCodexAskExposure(`${meta}\n${tools([namespace('functions', ['exec', 'wait'])])}`),
  ).toEqual({
    surface: 'code-mode',
    cliVersion: '0.166.0',
  })
})

test('recognized rollout with run_tests under a namespace is top-level', () => {
  expect(
    parseCodexAskExposure(
      tools([namespace('functions', ['exec']), namespace('bottega-ask', ['run_tests'])]),
    ),
  ).toEqual({ surface: 'top-level', cliVersion: null })
})

test('recognized rollout with neither ask tool nor exec is absent', () => {
  expect(parseCodexAskExposure(tools([namespace('functions', ['wait'])]))).toEqual({
    surface: 'absent',
    cliVersion: null,
  })
})

test('unrecognized format preserves a session_meta CLI version as unknown', () => {
  expect(parseCodexAskExposure(`${meta}\n${JSON.stringify({ type: 'different' })}`)).toEqual({
    surface: 'unknown',
    cliVersion: '0.166.0',
  })
})

test('empty and missing rollout input are unknown without a CLI version', () => {
  expect(parseCodexAskExposure('')).toEqual({ surface: 'unknown', cliVersion: null })
  expect(parseCodexAskExposure(null)).toEqual({ surface: 'unknown', cliVersion: null })
})

test('turn slice ignores an earlier exposure record but retains the chain CLI version', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-exposure-'))
  const sessions = join(root, 'sessions', '2026', '10', '31')
  const rollout = join(sessions, 'rollout-turn.jsonl')
  mkdirSync(sessions, { recursive: true })
  const earlier = `${meta}\n${tools([namespace('functions', ['exec'])])}\n`
  writeFileSync(rollout, earlier)
  try {
    const texts = codexRolloutTextsSince(
      root,
      new Map([[realpathSync(rollout), Buffer.byteLength(earlier)]]),
    )
    expect(codexAskExposureFromTexts(texts.slice, texts.full)).toEqual({
      surface: 'unknown',
      cliVersion: '0.166.0',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn slice classifies its own additional_tools record after the offset', () => {
  const earlier = `${meta}\n${tools([namespace('functions', ['wait'])])}\n`
  const current = tools([namespace('functions', ['exec'])])
  expect(codexAskExposureFromTexts(current, `${earlier}${current}`)).toEqual({
    surface: 'code-mode',
    cliVersion: '0.166.0',
  })
})

test('event builder emits Codex exposure with the prescribed note', () => {
  expect(askExposureEvent('codex', { surface: 'code-mode', cliVersion: '0.166.0' }, 'now')).toEqual(
    {
      ts: 'now',
      type: 'ask_exposure',
      surface: 'code-mode',
      cli_version: '0.166.0',
      note: 'code-mode means exec offered, nested set not enumerated; not proof run_tests was reachable',
    },
  )
  expect(askExposureEvent('codex', { surface: 'top-level', cliVersion: null }, 'now')?.note).toBe(
    null,
  )
  expect(askExposureEvent('claude', { surface: 'code-mode', cliVersion: null }, 'now')).toBeNull()
})
