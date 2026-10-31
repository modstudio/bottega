// Tests codex-ask-exposure.ts: observed rollout parsing and newest-rollout selection.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAskExposureFromHome, parseCodexAskExposure } from './codex-ask-exposure.ts'

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

test('home adapter reads the newest rollout without spawning', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-exposure-'))
  const sessions = join(root, 'sessions', '2026', '10', '31')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 'rollout-new.jsonl'),
    `${meta}\n${tools([namespace('functions', ['exec'])])}`,
  )
  try {
    expect(codexAskExposureFromHome(root)).toEqual({
      surface: 'code-mode',
      cliVersion: '0.166.0',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
