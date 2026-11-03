import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideRecordPassword, RECORD_PASSWORD_ENV, recordPassword } from './record-auth-command.ts'

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
