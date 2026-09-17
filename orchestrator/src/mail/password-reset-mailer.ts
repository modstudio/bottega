// concern: password-reset-mailer
/** Owns the SES transport for password-reset messages. */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { PLATFORM_NAME } from '../../../shared/brand.ts'

type MailEnvironment = Record<string, string | undefined>
type SesPort = { send(command: SendEmailCommand): Promise<unknown> }

const TEST_REFUSAL = 'password reset mailer refuses a real SES client under the test runner'

function required(environment: MailEnvironment, name: string) {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to send password reset email`)
  return value
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function sendPasswordResetEmail(
  input: { to: string; resetUrl: string },
  environment: MailEnvironment = process.env,
  injectedClient?: SesPort,
) {
  if (process.env.NODE_ENV === 'test' && !injectedClient) throw new Error(TEST_REFUSAL)
  const region = required(environment, 'SES_REGION')
  const from = required(environment, 'SES_FROM_ADDRESS')
  const accessKeyId = required(environment, 'SES_ACCESS_KEY_ID')
  const secretAccessKey = required(environment, 'SES_SECRET_ACCESS_KEY')
  const client =
    injectedClient ?? new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } })
  const subject = `${PLATFORM_NAME} password reset`
  const text = [
    `A password reset was requested for ${input.to}.`,
    '',
    `Set a new password: ${input.resetUrl}`,
    '',
    'This link lasts one hour and works once.',
    'If you did not request this message, you can ignore it.',
  ].join('\n')
  const html = `<p>A password reset was requested for ${escapeHtml(input.to)}.</p><p><a href="${escapeHtml(input.resetUrl)}">Set a new password</a></p><p>This link lasts one hour and works once.</p><p>If you did not request this message, you can ignore it.</p>`
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: text, Charset: 'UTF-8' },
            Html: { Data: html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  )
}
