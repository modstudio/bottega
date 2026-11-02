import { expect, test } from 'bun:test'
import { commitMessageText } from './check-prose.ts'

test('commit message extraction removes comments and the scissors tail', () => {
  expect(
    commitMessageText(
      'DEV-2016 clean subject\n# template\nBody\n# ------------------------ >8 ------------------------\nignored',
    ),
  ).toBe('DEV-2016 clean subject\nBody')
})
