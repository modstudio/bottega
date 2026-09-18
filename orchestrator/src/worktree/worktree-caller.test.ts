import { describe, expect, test } from 'bun:test'
import { shouldAssertCallerAncestry } from './worktree-caller.ts'

describe('shouldAssertCallerAncestry', () => {
  test('carry into a potentially diverged tree asserts', () => {
    expect(shouldAssertCallerAncestry(true, false)).toBe(true)
  })

  test('no carry skips the assertion', () => {
    expect(shouldAssertCallerAncestry(false, false)).toBe(false)
  })

  test('resume skips the assertion', () => {
    expect(shouldAssertCallerAncestry(true, true)).toBe(false)
  })
})
