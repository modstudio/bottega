// concern: invitation-mailer
/** Owns record-space invitation message content. */

import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { escapeHtml, type MailEnvironment, type SesPort, sendSesEmail } from './ses-mailer.ts'

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
  const subject = `${PLATFORM_NAME} invitation to ${input.spaceName}`
  const text = [
    `${input.inviterName} invited you to join ${input.spaceName} as ${input.role}.`,
    '',
    `Accept the invitation: ${input.invitationUrl}`,
    '',
    'This invitation lasts seven days.',
  ].join('\n')
  const html = `<p>${escapeHtml(input.inviterName)} invited you to join ${escapeHtml(input.spaceName)} as ${escapeHtml(input.role)}.</p><p><a href="${escapeHtml(input.invitationUrl)}">Accept the invitation</a></p><p>This invitation lasts seven days.</p>`
  await sendSesEmail({ to: input.to, subject, text, html }, environment, injectedClient)
}
