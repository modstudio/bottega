// concern: email-verification-mailer
/** Owns email-verification message content. */

import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { escapeHtml, type MailEnvironment, type SesPort, sendSesEmail } from './ses-mailer.ts'

export async function sendEmailVerificationEmail(
  input: { to: string; verifyUrl: string },
  environment: MailEnvironment = process.env,
  injectedClient?: SesPort,
) {
  const subject = `${PLATFORM_NAME} email verification`
  const text = [
    `Verify the email address ${input.to}.`,
    '',
    `Verify your email: ${input.verifyUrl}`,
    '',
    'This link lasts one hour.',
    'If you did not request this message, you can ignore it.',
  ].join('\n')
  const html = `<p>Verify the email address ${escapeHtml(input.to)}.</p><p><a href="${escapeHtml(input.verifyUrl)}">Verify your email</a></p><p>This link lasts one hour.</p><p>If you did not request this message, you can ignore it.</p>`
  await sendSesEmail({ to: input.to, subject, text, html }, environment, injectedClient)
}
