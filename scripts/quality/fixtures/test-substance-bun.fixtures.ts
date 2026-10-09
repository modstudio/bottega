import { describe, expect, test } from 'bun:test'

describe('fixture', () => {
  test('has no assertion', () => {})
  test('is trivial', () => expect(true).toBe(true))
  test.only('is focused', () => expect(subject).toBe(expected))
  test.skip('is disabled', () => expect(subject).toBe(expected))
  test('has an invalid expect', () => {
    expect(subject)
  })
  test('is duplicated', () => expect(subject).toBe(expected))
  test('is duplicated', () => expect(subject).toBe(expected))
  test('compares itself', () => expect(subject).toEqual(subject))
  test('does not replace string contents', () => expect('bun:test').toBe('vitest'))
  // test-substance-allow: no-disabled-tests explained fixture waiver
  test('has an unused waiver', () => expect(subject).toBe(expected))
})

declare const subject: unknown
declare const expected: unknown
