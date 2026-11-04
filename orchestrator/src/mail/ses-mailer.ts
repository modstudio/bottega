// concern: ses-mailer
/** Owns the shared SES transport for record email. */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

export type MailEnvironment = Record<string, string | undefined>
export type SesPort = { send(command: SendEmailCommand): Promise<unknown> }

const TEST_REFUSAL = 'SES mail transport refuses a real client under the test runner'

function required(environment: MailEnvironment, name: string) {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to send email`)
  return value
}

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function sendSesEmail(
  input: { to: string; subject: string; text: string; html: string },
  environment: MailEnvironment,
  injectedClient?: SesPort,
) {
  if (process.env.NODE_ENV === 'test' && !injectedClient) throw new Error(TEST_REFUSAL)
  const region = required(environment, 'SES_REGION')
  const from = required(environment, 'SES_FROM_ADDRESS')
  const accessKeyId = required(environment, 'SES_ACCESS_KEY_ID')
  const secretAccessKey = required(environment, 'SES_SECRET_ACCESS_KEY')
  const client =
    injectedClient ?? new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } })
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: input.text, Charset: 'UTF-8' },
            Html: { Data: input.html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  )
}
