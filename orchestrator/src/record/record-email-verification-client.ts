// concern: record-email-verification-client
/** Owns the authenticated Better Auth verification-email request. */

import { recordApiRequest } from './record-api-client.ts'

export const recordApiSendVerificationEmail = (email: string) =>
  recordApiRequest<{ status: boolean }>('/api/auth/send-verification-email', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
