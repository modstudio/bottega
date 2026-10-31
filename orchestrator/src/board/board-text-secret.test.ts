import { expect, test } from 'bun:test'
import {
  abbreviateKnownCommitTokens,
  type BoardTextCallSite,
  prepareBoardText,
} from './board-text-secret.ts'

const SHA40 = 'e2279e5d1e3d5ea24eab5369bf54943595d740f8'
const SHA64 = '4a'.repeat(32)

test('known full commit hashes are abbreviated', () => {
  const known = (hex: string) => hex === SHA40 || hex === SHA64
  expect(abbreviateKnownCommitTokens(`deployed ${SHA40}`, known)).toBe(
    `deployed ${SHA40.slice(0, 12)}`,
  )
  expect(abbreviateKnownCommitTokens(`deployed ${SHA64}`, known)).toBe(
    `deployed ${SHA64.slice(0, 12)}`,
  )
})

test('an unknown full hash remains secret-shaped', () => {
  expect(abbreviateKnownCommitTokens(SHA40, () => false)).toBe(SHA40)
})

test('commit resolution is not consulted for abbreviated hashes', () => {
  let calls = 0
  expect(
    abbreviateKnownCommitTokens(SHA40.slice(0, 12), () => {
      calls += 1
      return true
    }),
  ).toBe(SHA40.slice(0, 12))
  expect(calls).toBe(0)
})

test('every board pre-send call site abbreviates known hashes and preserves unknown hashes', () => {
  const callSites: BoardTextCallSite[] = [
    'reply',
    'notice',
    'tag',
    'suggestion',
    'claim-note',
    'claim-resource',
    'filing-failure',
  ]
  for (const callSite of callSites) {
    expect(prepareBoardText(callSite, SHA40, '/projects/app', () => true)).toBe(SHA40.slice(0, 12))
    expect(prepareBoardText(callSite, SHA40, '/projects/app', () => false)).toBe(SHA40)
  }
})

test('a board pre-send path without a known project leaves text unchanged', () => {
  let calls = 0
  expect(
    prepareBoardText('reply', SHA40, null, () => {
      calls += 1
      return true
    }),
  ).toBe(SHA40)
  expect(calls).toBe(0)
})
