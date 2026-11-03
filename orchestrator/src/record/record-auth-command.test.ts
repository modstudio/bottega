import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideRecordPassword } from './record-auth-command.ts'

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
