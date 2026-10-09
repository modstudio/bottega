import { describe, expect, test } from './test-substance-runner-helper.fixtures'

describe('Bun runner suite', () => {
  test('clean: nested Bun test', () => expect(subject).toBe(expected))
})

declare const subject: unknown
declare const expected: unknown
