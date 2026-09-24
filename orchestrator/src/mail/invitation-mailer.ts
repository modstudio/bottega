// concern: invitation-mailer
/** Owns the SES transport for record-space invitation messages. */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { PLATFORM_NAME } from '../../../shared/brand.ts'

type MailEnvironment = Record<string, string | undefined>
type SesPort = { send(command: SendEmailCommand): Promise<unknown> }

const TEST_REFUSAL = 'invitation mailer refuses a real SES client under the test runner'

function required(environment: MailEnvironment, name: string) {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to send invitation email`)
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

export async function sendRecordInvitationEmail(
  input: {
    to: string
    invitationUrl: string
    spaceName: string
    inviterName: string
    role: string
  },
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
  const subject = `${PLATFORM_NAME} invitation to ${input.spaceName}`
  const text = [
    `${input.inviterName} invited you to join ${input.spaceName} as ${input.role}.`,
    '',
    `Accept the invitation: ${input.invitationUrl}`,
    '',
    'This invitation lasts seven days.',
  ].join('\n')
  const html = `<p>${escapeHtml(input.inviterName)} invited you to join ${escapeHtml(input.spaceName)} as ${escapeHtml(input.role)}.</p><p><a href="${escapeHtml(input.invitationUrl)}">Accept the invitation</a></p><p>This invitation lasts seven days.</p>`
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
