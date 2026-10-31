import { expect, test } from 'bun:test'
import { boardTextSecretRule } from './board-text-secret.ts'

const SHA40 = 'e2279e5d1e3d5ea24eab5369bf54943595d740f8'
const SHA64 = '4a'.repeat(32)

test('known full commit hashes are exempt without hiding another credential', () => {
  const known = (hex: string) => hex === SHA40 || hex === SHA64
  expect(boardTextSecretRule(`deployed ${SHA40}`, known)).toBeNull()
  expect(boardTextSecretRule(`deployed ${SHA64}`, known)).toBeNull()
  expect(boardTextSecretRule(`deployed ${SHA40} with password=secret`, known)).toBe('assignment')
})

test('an unknown full hash remains secret-shaped', () => {
  expect(boardTextSecretRule(SHA40, () => false)).toBe('hex-run')
})

test('commit resolution is not consulted for abbreviated hashes', () => {
  let calls = 0
  expect(
    boardTextSecretRule(SHA40.slice(0, 12), () => {
      calls += 1
      return true
    }),
  ).toBeNull()
  expect(calls).toBe(0)
})
