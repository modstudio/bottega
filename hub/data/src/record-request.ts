import { recordApiUrl } from './hub-mode.ts'

function recordUrl(path: string) {
  const base = recordApiUrl()
  if (!base) throw new Error('VITE_RECORD_API_URL is required')
  return `${base}${path}`
}

export function recordErrorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const value = body as Record<string, unknown>
  if (typeof value.message === 'string' && value.message) return value.message
  if (value.error && typeof value.error === 'object') {
    const error = value.error as Record<string, unknown>
    if (typeof error.message === 'string' && error.message) return error.message
  }
  if (typeof value.error === 'string' && value.error) return value.error
  return fallback
}

export function recordRequest(path: string, init?: RequestInit) {
  return fetch(recordUrl(path), {
    ...init,
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
}
