import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideRecordPassword,
  RECORD_PASSWORD_ENV,
  recordPassword,
  verificationEmailAction,
  verifyEmailCommand,
} from './record-auth-command.ts'

const originalRecordPassword = process.env[RECORD_PASSWORD_ENV]

beforeEach(() => {
  delete process.env[RECORD_PASSWORD_ENV]
})

afterEach(() => {
  if (originalRecordPassword === undefined) delete process.env[RECORD_PASSWORD_ENV]
  else process.env[RECORD_PASSWORD_ENV] = originalRecordPassword
})

test.each([false, true])(
  'an environment password takes precedence when stdin TTY is %p',
  (isTTY) => {
    expect(decideRecordPassword('secret', isTTY)).toEqual({
      action: 'use-environment',
      password: 'secret',
    })
  },
)

test('an unset environment password without a TTY refuses with the non-interactive remedy', () => {
  expect(decideRecordPassword(undefined, false)).toEqual({
    action: 'refuse',
    message: `record password is required: stdin is not a terminal; set ${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD to supply it non-interactively`,
  })
})

test('an unset environment password with a TTY prompts', () => {
  expect(decideRecordPassword(undefined, true)).toEqual({ action: 'prompt' })
})

test('record password accepts a provided password independent of process stdin', async () => {
  await expect(recordPassword(async () => 'provided')).resolves.toBe('provided')
})

test('verification email decision distinguishes verified and unverified users', () => {
  expect(verificationEmailAction({ email: 'verified@example.test', emailVerified: true })).toEqual({
    action: 'already-verified',
    email: 'verified@example.test',
  })
  expect(verificationEmailAction({ email: 'new@example.test', emailVerified: false })).toEqual({
    action: 'send',
    email: 'new@example.test',
  })
})

test('verify-email sends only for an unverified signed-in user', async () => {
  const output: string[] = []
  const sent: string[] = []
  await verifyEmailCommand(
    { log: (value) => output.push(value) },
    {
      identity: async () =>
        ({ user: { email: 'new@example.test', emailVerified: false } }) as never,
      send: async (email) => {
        sent.push(email)
        return { status: true }
      },
    },
  )
  expect(sent).toEqual(['new@example.test'])
  expect(output).toEqual(['verification mail sent to new@example.test'])
})

test('verify-email reports an already verified user without sending', async () => {
  const output: string[] = []
  let sends = 0
  await verifyEmailCommand(
    { log: (value) => output.push(value) },
    {
      identity: async () =>
        ({ user: { email: 'verified@example.test', emailVerified: true } }) as never,
      send: async () => {
        sends++
        return { status: true }
      },
    },
  )
  expect(sends).toBe(0)
  expect(output).toEqual(['verified@example.test is already verified'])
})
