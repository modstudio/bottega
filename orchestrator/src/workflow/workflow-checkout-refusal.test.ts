import { expect, test } from 'bun:test'
import { decideCheckoutAnswer } from './workflow-checkout-refusal.ts'

test('an existing recorded cwd answers checkout questions', () => {
  expect(
    decideCheckoutAnswer({
      recordedCwd: '/fixture/work',
      recordedCwdIsDirectory: true,
      mainCheckoutPath: '/fixture/main',
    }),
  ).toEqual({ checkoutPath: '/fixture/work' })
})

test('the registered main checkout answers after the recorded cwd is removed', () => {
  expect(
    decideCheckoutAnswer({
      recordedCwd: '/fixture/removed-work',
      recordedCwdIsDirectory: false,
      mainCheckoutPath: '/fixture/main',
    }),
  ).toEqual({ checkoutPath: '/fixture/main' })
})

test('a removed cwd without a registered main checkout names both missing facts', () => {
  expect(
    decideCheckoutAnswer({
      recordedCwd: '/fixture/removed-work',
      recordedCwdIsDirectory: false,
      mainCheckoutPath: null,
    }),
  ).toEqual({
    refusal:
      'recorded evidence cwd /fixture/removed-work is no longer a directory and the cursor project has no registered main checkout',
  })
})
