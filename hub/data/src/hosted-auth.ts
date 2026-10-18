import { recordErrorMessage, recordRequest } from './record-request.ts'

export async function signInWithEmail(email: string, password: string) {
  const response = await recordRequest('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    throw new Error(
      recordErrorMessage(await response.json().catch(() => null), 'Could not sign in'),
    )
  }
}

export async function requestPasswordReset(email: string) {
  const response = await recordRequest('/api/auth/request-password-reset', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  if (!response.ok) throw new Error('Could not request a password reset')
}

export async function resetPassword(token: string, newPassword: string) {
  const response = await recordRequest('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
  if (!response.ok) throw new Error('This password reset link is invalid or has expired')
}

export async function signOutFromRecord() {
  const response = await recordRequest('/api/auth/sign-out', {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(
      recordErrorMessage(await response.json().catch(() => null), 'Could not sign out'),
    )
  }
}
