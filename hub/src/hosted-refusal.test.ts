import { describe, expect, test } from 'bun:test'
import { hostedRefusalError } from './hosted-refusal.ts'

describe('hosted refusal text', () => {
  test('uses a 401 error and remedy for a probe', () => {
    const error = hostedRefusalError({
      status: 401,
      statusText: 'Unauthorized',
      body: { error: 'record session is missing or expired', remedy: 'sign in again' },
      safety: 'probe',
    })
    expect(error.message).toBe(
      'hosted hub refused the request (401): record session is missing or expired. sign in again. nothing was written',
    )
  })

  test('reports a network error on a non-idempotent write as ambiguous', () => {
    const error = hostedRefusalError({
      cause: new TypeError('connection closed'),
      safety: 'non-idempotent',
    })
    expect(error.message).toBe(
      'hosted hub refused the request (network error): connection closed. the write may have been applied; check before retrying',
    )
  })

  test('reports a 4xx write as not applied', () => {
    const error = hostedRefusalError({
      status: 422,
      statusText: 'Unprocessable Content',
      safety: 'non-idempotent',
    })
    expect(error.message).toBe(
      'hosted hub refused the request (422): Unprocessable Content. nothing was written',
    )
  })

  test('trusts a server remedy that says a non-idempotent write was not applied', () => {
    const error = hostedRefusalError({
      status: 503,
      body: { error: 'record API unavailable (503)', remedy: 'nothing was written; retry' },
      safety: 'non-idempotent',
    })
    expect(error.message).toBe(
      'hosted hub refused the request (503): record API unavailable (503). nothing was written; retry',
    )
    expect(error.message).not.toContain('check before retrying')
  })
})
