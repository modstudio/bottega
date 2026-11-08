import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  activeMembershipSpace,
  ensurePersonalSpace,
  noSpaceBuiltIns,
  type PersonalSpace,
  recordAllowedOrigins,
  recordAuth,
  recordIdentityFromRows,
  refuseTrialMarkerUpdate,
  rememberedSessionSpaceWrite,
  sessionSpace,
} from './record-auth.ts'
import { RECORD_INVITATION_EXPIRES_IN_SECONDS } from './record-invitation.ts'

let priorSecret: string | undefined
let priorHubUrl: string | undefined
beforeAll(() => {
  priorSecret = process.env.BETTER_AUTH_SECRET
  priorHubUrl = process.env.RECORD_HUB_URL
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-thirty-two-characters'
  process.env.RECORD_HUB_URL = 'https://hub.example.test'
})

test('organization updates cannot change the trial marker', () => {
  expect(() => refuseTrialMarkerUpdate({}, { trial: { createdAt: 'now' } })).toThrow(
    'metadata.trial is immutable',
  )
  expect(() => refuseTrialMarkerUpdate({ trial: { createdAt: 'then' } }, {})).toThrow(
    'metadata.trial is immutable',
  )
  expect(() =>
    refuseTrialMarkerUpdate(
      { trial: { createdAt: 'then' } },
      JSON.stringify({ trial: { createdAt: 'then' } }),
    ),
  ).not.toThrow()
})
afterAll(() => {
  if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = priorSecret
  if (priorHubUrl === undefined) delete process.env.RECORD_HUB_URL
  else process.env.RECORD_HUB_URL = priorHubUrl
})

test('auth instance builds without connecting to a database', () => {
  const auth = recordAuth(
    'postgres://record.invalid/database',
    process.env,
    undefined,
    undefined,
    undefined,
    noSpaceBuiltIns,
  )
  const api = auth.api
  expect(api.signInEmail).toBeFunction()
  expect(api.requestPasswordReset).toBeFunction()
  expect(api.resetPassword).toBeFunction()
  expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12)
  expect(auth.options.rateLimit).toMatchObject({
    enabled: true,
    window: 10,
    max: 100,
    storage: 'database',
  })
  expect(auth.options.rateLimit?.customRules?.['/request-password-reset']).toEqual({
    window: 60 * 60,
    max: 5,
  })
})

test('email verification sends on sign-up through the injected sender', async () => {
  let sent: { to: string; verifyUrl: string } | undefined
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test',
    },
    undefined,
    async () => {},
    undefined,
    noSpaceBuiltIns,
    async (input) => {
      sent = input
    },
  )
  expect(auth.options.emailVerification?.sendOnSignUp).toBe(true)
  await auth.options.emailVerification?.sendVerificationEmail?.({
    user: { email: 'reader@example.test' } as never,
    url: 'https://api.example.test/api/auth/verify-email?token=one&callbackURL=%2F',
    token: 'one',
  })
  expect(sent).toEqual({
    to: 'reader@example.test',
    verifyUrl:
      'https://api.example.test/api/auth/verify-email?token=one&callbackURL=https%3A%2F%2Fhub.example.test%2Fsign-in%3Fverified%3D1',
  })
})

test('email verification preserves the Better Auth URL when the hub is not configured', async () => {
  let sent: { to: string; verifyUrl: string } | undefined
  const auth = recordAuth(
    'postgres://record.invalid/database',
    { BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters' },
    undefined,
    async () => {},
    undefined,
    noSpaceBuiltIns,
    async (input) => {
      sent = input
    },
  )
  const verifyUrl = 'https://api.example.test/api/auth/verify-email?callbackURL=%2F&token=one'
  await auth.options.emailVerification?.sendVerificationEmail?.({
    user: { email: 'reader@example.test' } as never,
    url: verifyUrl,
    token: 'one',
  })
  expect(sent?.verifyUrl).toBe(verifyUrl)
})

test('the configured hub origin is trusted without duplicate allowed-origin configuration', () => {
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test/path',
    },
    undefined,
    async () => {},
    undefined,
    noSpaceBuiltIns,
  )
  expect(auth.options.trustedOrigins).toEqual(['https://hub.example.test'])
})

test('the configured hub origin is not duplicated in trusted origins', () => {
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test',
      RECORD_API_ALLOWED_ORIGINS: 'https://hub.example.test',
    },
    undefined,
    async () => {},
    undefined,
    noSpaceBuiltIns,
  )
  expect(auth.options.trustedOrigins).toEqual(['https://hub.example.test'])
})

test('password reset links use the configured hosted hub and the injected sender', async () => {
  let sent: { to: string; resetUrl: string } | undefined
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test',
    },
    undefined,
    async (input) => {
      sent = input
    },
    undefined,
    noSpaceBuiltIns,
  )
  const hook = auth.options.emailAndPassword?.sendResetPassword
  await hook?.({ user: { email: 'reader@example.test' } as never, token: 'token-one', url: '' })
  expect(sent).toEqual({
    to: 'reader@example.test',
    resetUrl: 'https://hub.example.test/reset-password?token=token-one',
  })
})

test('organization invitations use the seven-day lifetime and configured hosted hub', async () => {
  let sent: Parameters<NonNullable<Parameters<typeof recordAuth>[4]>>[0] | undefined
  const auth = recordAuth(
    'postgres://record.invalid/database',
    {
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      RECORD_HUB_URL: 'https://hub.example.test',
    },
    'postgres://record-auth.invalid/database',
    async () => {},
    async (input) => {
      sent = input
    },
    noSpaceBuiltIns,
  )
  const organizationOptions = auth.options.plugins?.find(
    (plugin) => plugin.id === 'organization',
  )?.options
  expect(organizationOptions?.invitationExpiresIn).toBe(RECORD_INVITATION_EXPIRES_IN_SECONDS)
  await organizationOptions?.sendInvitationEmail?.({
    id: 'invitation-one',
    email: 'invitee@example.test',
    organization: { name: 'Shared Space' },
    inviter: { user: { name: 'Avery Owner' } },
    role: 'admin',
  } as never)
  expect(sent).toEqual({
    to: 'invitee@example.test',
    invitationUrl: 'https://hub.example.test/accept-invitation/invitation-one',
    spaceName: 'Shared Space',
    inviterName: 'Avery Owner',
    role: 'admin',
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

test('session updates remember only a non-null active space', () => {
  expect(rememberedSessionSpaceWrite({ activeOrganizationId: 'space-a' })).toEqual({
    activeSpaceId: 'space-a',
  })
  expect(rememberedSessionSpaceWrite({ activeOrganizationId: null })).toBeNull()
  expect(rememberedSessionSpaceWrite({})).toBeNull()
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
