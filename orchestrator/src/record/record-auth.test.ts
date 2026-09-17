import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  ensurePersonalSpace,
  type PersonalSpace,
  recordAllowedOrigins,
  recordAuth,
} from './record-auth.ts'

let priorSecret: string | undefined
beforeAll(() => {
  priorSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-thirty-two-characters'
})
afterAll(() => {
  if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = priorSecret
})

test('auth instance builds without connecting to a database', () => {
  expect(recordAuth('postgres://record.invalid/database').api.signInEmail).toBeFunction()
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
