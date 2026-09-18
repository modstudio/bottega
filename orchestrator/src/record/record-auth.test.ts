import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  activeMembershipSpace,
  ensurePersonalSpace,
  type PersonalSpace,
  recordAllowedOrigins,
  recordAuth,
  recordIdentityFromRows,
  sessionSpace,
} from './record-auth.ts'

let priorSecret: string | undefined
let priorHubUrl: string | undefined
beforeAll(() => {
  priorSecret = process.env.BETTER_AUTH_SECRET
  priorHubUrl = process.env.RECORD_HUB_URL
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-thirty-two-characters'
  process.env.RECORD_HUB_URL = 'https://hub.example.test'
})
afterAll(() => {
  if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = priorSecret
  if (priorHubUrl === undefined) delete process.env.RECORD_HUB_URL
  else process.env.RECORD_HUB_URL = priorHubUrl
})

test('auth instance builds without connecting to a database', () => {
  const auth = recordAuth('postgres://record.invalid/database')
  const api = auth.api
  expect(api.signInEmail).toBeFunction()
  expect(api.requestPasswordReset).toBeFunction()
  expect(api.resetPassword).toBeFunction()
  expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12)
  expect(auth.options.rateLimit).toMatchObject({ enabled: true, window: 10, max: 100 })
  expect(auth.options.rateLimit?.customRules?.['/request-password-reset']).toEqual({
    window: 60 * 60,
    max: 5,
  })
})

test('password reset links use the configured hosted hub and the injected sender', async () => {
  let sent: { to: string; resetUrl: string } | undefined
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test',
    },
    async (input) => {
      sent = input
    },
  )
  const hook = auth.options.emailAndPassword?.sendResetPassword
  await hook?.({ user: { email: 'reader@example.test' } as never, token: 'token-one', url: '' })
  expect(sent).toEqual({
    to: 'reader@example.test',
    resetUrl: 'https://hub.example.test/reset-password?token=token-one',
  })
})

test('browser origins are exact and optional', () => {
  expect(recordAllowedOrigins({})).toEqual([])
  expect(
    recordAllowedOrigins({
      RECORD_API_ALLOWED_ORIGINS: 'https://hub.example.test, https://other.example.test',
    }),
  ).toEqual(['https://hub.example.test', 'https://other.example.test'])
  expect(() =>
    recordAllowedOrigins({ RECORD_API_ALLOWED_ORIGINS: 'https://hub.example.test/path' }),
  ).toThrow('contains an invalid origin')
})

test('personal-space decision reuses an existing space and creates only when absent', async () => {
  let found: PersonalSpace | null = null
  let creates = 0
  const port = {
    find: async () => found,
    create: async (input: PersonalSpace) => {
      creates++
      found = input
      return input
    },
  }
  const first = await ensurePersonalSpace('01990000-0000-7000-8000-000000000010', port)
  expect(first.slug).toBe('user-01990000-0000-7000-8000-000000000010')
  expect(await ensurePersonalSpace('01990000-0000-7000-8000-000000000010', port)).toEqual(first)
  expect(creates).toBe(1)
})

test('session activates a remembered membership instead of the personal space', () => {
  expect(
    sessionSpace({
      rememberedSpaceId: 'work',
      personalSpaceId: 'personal',
      membershipSpaceIds: ['personal', 'work'],
    }),
  ).toBe('work')
})

test('session ignores a departed remembered space and falls back through memberships', () => {
  expect(
    sessionSpace({
      rememberedSpaceId: 'departed',
      personalSpaceId: 'personal',
      membershipSpaceIds: ['personal', 'oldest-work', 'newest-work'],
    }),
  ).toBe('oldest-work')
  expect(
    sessionSpace({
      rememberedSpaceId: 'departed',
      personalSpaceId: 'personal',
      membershipSpaceIds: ['personal'],
    }),
  ).toBe('personal')
})

test('active space is kept only while it is a current membership', () => {
  expect(activeMembershipSpace('current', ['personal', 'current'])).toBe('current')
  expect(activeMembershipSpace('departed', ['personal', 'current'])).toBeNull()
})

test('record identity maps membership rows before exposing the active space', () => {
  const user = { id: 'user-one' }
  const memberships = [{ space_id: 'personal' }, { space_id: 'current' }]
  expect(recordIdentityFromRows(user, 'current', 'personal', memberships).activeSpaceId).toBe(
    'current',
  )
  expect(recordIdentityFromRows(user, 'departed', 'personal', memberships).activeSpaceId).toBeNull()
})
