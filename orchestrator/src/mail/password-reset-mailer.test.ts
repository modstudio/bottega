import { describe, expect, test } from 'bun:test'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { sendPasswordResetEmail } from './password-reset-mailer.ts'

const environment = {
  SES_REGION: 'us-east-2',
  SES_FROM_ADDRESS: 'Sender <sender@example.test>',
  SES_ACCESS_KEY_ID: 'test-access-key',
  SES_SECRET_ACCESS_KEY: 'test-secret-key',
}

describe('password reset mailer', () => {
  test('builds and sends the plain, one-use reset message through the injected SES client', async () => {
    let command: SendEmailCommand | undefined
    await sendPasswordResetEmail(
      { to: 'reader@example.test', resetUrl: 'https://hub.example.test/reset-password?token=one' },
      environment,
      { send: async (value) => (command = value) },
    )
    expect(command).toBeInstanceOf(SendEmailCommand)
    expect(command?.input).toEqual({
      FromEmailAddress: environment.SES_FROM_ADDRESS,
      Destination: { ToAddresses: ['reader@example.test'] },
      Content: {
        Simple: {
          Subject: { Data: `${PLATFORM_NAME} password reset`, Charset: 'UTF-8' },
          Body: {
            Text: {
              Data: expect.stringContaining('This link lasts one hour and works once.'),
              Charset: 'UTF-8',
            },
            Html: {
              Data: expect.stringContaining('https://hub.example.test/reset-password?token=one'),
              Charset: 'UTF-8',
            },
          },
        },
      },
    })
  })

  test('refuses a real SES client under the test runner', async () => {
    expect(
      sendPasswordResetEmail(
        { to: 'reader@example.test', resetUrl: 'https://example.test' },
        environment,
      ),
    ).rejects.toThrow('password reset mailer refuses a real SES client under the test runner')
  })
})
