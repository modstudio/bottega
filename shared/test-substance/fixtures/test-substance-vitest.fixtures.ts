import { describe, expect, test } from 'vitest'
import { expectImported, refusedBy } from './test-substance-fixture-helper.fixtures'

function expectThroughHelper() {
  expect(subject).toBe(expected)
}

describe('fixture', () => {
  test('has no assertion', () => {})
  test('asserts through a same-file helper', () => expectThroughHelper())
  test('asserts through an imported helper', () => expectImported())
  test('clean: implicit helper return', () => expectThroughHelper())
  test('clean: assertion-named property call', () => row.assertForwarded())
  test('clean: expect message', () => expect(subject, 'subject').toBe(expected))
  test('clean: imported helper with any name', async () => {
    await refusedBy(Promise.reject(new Error('constraint')), 'constraint_name')
  })
  test('genuine: fixed literal comparison', () => {
    const sessionMarker = 'on'
    expect(sessionMarker).toBe('on')
  })
  test('clean: saved asynchronous assertion', async () => {
    const refused = expect(Promise.reject(new Error('deadline'))).rejects.toThrow('deadline')
    await Promise.resolve()
    await refused
  })
  test('genuine: calls helpers without assertions', () => doesNothing())
  test('is trivial', () => expect(true).toBe(true))
  test('has an unawaited assertion', () => {
    expect(Promise.resolve(1)).resolves.toBe(1)
  })
  test('clean: unrelated rejects property', () => {
    api.rejects()
    expect(subject).toBe(expected)
  })
  test.only('is focused', () => expect(subject).toBe(expected))
  test.skip('is disabled', () => expect(subject).toBe(expected))
  test('has an invalid expect', () => expect(subject))
  test('is duplicated', () => expect(subject).toBe(expected))
  test('is duplicated', () => expect(subject).toBe(expected))
  test('compares itself', () => expect(subject).toEqual(subject))
  // test-substance-allow: no-disabled-tests explained fixture waiver
  test('has an unused waiver', () => expect(subject).toBe(expected))

  const survives = (_row: string) => {
    expect(subject).toBe(expected)
  }
  function expectInOrder(_patterns: string[]) {
    expect(subject).toBe(expected)
  }
  async function survivesAsync(_row: string) {
    expect(subject).toBe(expected)
  }
  async function spend() {
    for (const name of ['route']) await expect(Promise.resolve(name)).resolves.toBeDefined()
  }
  test('clean: nested arrow helper', () => survives('| C |'))
  test('clean: nested function helper', () => expectInOrder(['first', 'second']))
  test('clean: nested async helper', async () => await survivesAsync('| G |'))
  test('clean: transitive loop helper', async () => await spend())
})

function doesNothing() {
  return subject
}

declare const subject: unknown
declare const expected: unknown
declare const row: { assertForwarded(): void }
declare const api: { rejects(): void }
