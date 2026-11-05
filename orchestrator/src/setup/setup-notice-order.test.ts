import { expect, test } from 'bun:test'
import { orderSetupNotices } from './setup-notice-order.ts'

test('notices that stop setup capabilities working come before advisory notices', () => {
  const ordered = orderSetupNotices([
    { message: 'no gate was detected for alpha', fix: 'set a gate' },
    { message: 'gh is signed out', fix: 'sign in' },
    { message: 'codex agent is enabled but the codex harness is not installed', fix: 'install it' },
    { message: 'git inspection timed out for beta', fix: 'inspect it' },
  ])
  expect(ordered.map(({ message }) => message)).toEqual([
    'gh is signed out',
    'codex agent is enabled but the codex harness is not installed',
    'git inspection timed out for beta',
    'no gate was detected for alpha',
  ])
})
