import { recordApiUrl } from './hub-mode.ts'

function authUrl(path: string) {
  const base = recordApiUrl()
  if (!base) throw new Error('VITE_RECORD_API_URL is required')
  return `${base}${path}`
}

function errorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  if (typeof record.message === 'string' && record.message) return record.message
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message) return nested.message
  }
  if (typeof record.error === 'string' && record.error) return record.error
  return fallback
}

export async function signInWithEmail(email: string, password: string) {
  const response = await fetch(authUrl('/api/auth/sign-in/email'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    throw new Error(errorMessage(await response.json().catch(() => null), 'Could not sign in'))
  }
}

export async function requestPasswordReset(email: string) {
  const response = await fetch(authUrl('/api/auth/request-password-reset'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!response.ok) throw new Error('Could not request a password reset')
}

export async function resetPassword(token: string, newPassword: string) {
  const response = await fetch(authUrl('/api/auth/reset-password'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  })
  if (!response.ok) throw new Error('This password reset link is invalid or has expired')
}

export async function signOutFromRecord() {
  const response = await fetch(authUrl('/api/auth/sign-out'), {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(errorMessage(await response.json().catch(() => null), 'Could not sign out'))
  }
}
