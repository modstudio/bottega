import { describe, expect, test } from 'vitest'
import { expectImported } from './test-substance-fixture-helper'

function expectThroughHelper() {
  expect(subject).toBe(expected)
}

describe('fixture', () => {
  test('has no assertion', () => {})
  test('asserts through a same-file helper', () => expectThroughHelper())
  test('asserts through an imported helper', () => expectImported())
  test('is trivial', () => expect(true).toBe(true))
  test('has an unawaited assertion', () => {
    expect(Promise.resolve(1)).resolves.toBe(1)
  })
  test.only('is focused', () => expect(subject).toBe(expected))
  test.skip('is disabled', () => expect(subject).toBe(expected))
  test('has an invalid expect', () => expect(subject))
  test('is duplicated', () => expect(subject).toBe(expected))
  test('is duplicated', () => expect(subject).toBe(expected))
  test('compares itself', () => expect(subject).toEqual(subject))
  // test-substance-allow: no-disabled-tests explained fixture waiver
  test('has an unused waiver', () => expect(subject).toBe(expected))
})

declare const subject: unknown
declare const expected: unknown
