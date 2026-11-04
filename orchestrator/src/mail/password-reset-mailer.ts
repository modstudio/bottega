// concern: password-reset-mailer
/** Owns password-reset message content. */

import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { escapeHtml, type MailEnvironment, type SesPort, sendSesEmail } from './ses-mailer.ts'

export async function sendPasswordResetEmail(
  input: { to: string; resetUrl: string },
  environment: MailEnvironment = process.env,
  injectedClient?: SesPort,
) {
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
  await sendSesEmail({ to: input.to, subject, text, html }, environment, injectedClient)
}
