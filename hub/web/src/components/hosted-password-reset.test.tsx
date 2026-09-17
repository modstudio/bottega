import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedResetPassword, validateResetPassword } from './hosted-password-reset'

test('reset validation rejects a mismatch and a short password', () => {
  expect(validateResetPassword('long-enough-password', 'different-password')).toBe(
    'Passwords do not match',
  )
  expect(validateResetPassword('short', 'short')).toBe('Password must be at least 12 characters')
})

test('an expired, used, or missing token renders the failure state', () => {
  for (const page of [
    <HostedResetPassword key="used" token="used-token" invalid />,
    <HostedResetPassword key="missing" />,
  ]) {
    const html = renderToStaticMarkup(page)
    expect(html).toContain('This password reset link is invalid or has expired.')
    expect(html).toContain('/forgot-password')
  }
})
