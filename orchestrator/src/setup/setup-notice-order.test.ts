import { expect, test } from 'bun:test'
import { orderSetupNotices } from './setup-notice-order.ts'

test('notices that stop setup capabilities working come before advisory notices', () => {
  const ordered = orderSetupNotices([
    { message: 'advisory', fix: 'set a gate', blocking: false },
    { message: 'first blocking notice', fix: 'sign in', blocking: true },
    { message: 'second blocking notice', fix: 'install it', blocking: true },
    { message: 'third blocking notice', fix: 'inspect it', blocking: true },
  ])
  expect(ordered.map(({ message }) => message)).toEqual([
    'first blocking notice',
    'second blocking notice',
    'third blocking notice',
    'advisory',
  ])
})
