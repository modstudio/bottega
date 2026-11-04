import { expect, test } from 'bun:test'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { sendEmailVerificationEmail } from './email-verification-mailer.ts'

const environment = {
  SES_REGION: 'us-east-2',
  SES_FROM_ADDRESS: 'Sender <sender@example.test>',
  SES_ACCESS_KEY_ID: 'test-access-key',
  SES_SECRET_ACCESS_KEY: 'test-secret-key',
}

test('sends the verification address, subject, and link through SES', async () => {
  let command: SendEmailCommand | undefined
  const verifyUrl = 'https://api.example.test/api/auth/verify-email?token=one'
  await sendEmailVerificationEmail({ to: 'reader@example.test', verifyUrl }, environment, {
    send: async (value) => (command = value),
  })
  expect(command).toBeInstanceOf(SendEmailCommand)
  expect(command?.input.Destination?.ToAddresses).toEqual(['reader@example.test'])
  expect(command?.input.Content?.Simple?.Subject?.Data).toBe(`${PLATFORM_NAME} email verification`)
  expect(command?.input.Content?.Simple?.Body?.Text?.Data).toContain(verifyUrl)
})
