import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markRecordIdentityChanged } from '../../../shared/record-session.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { recordApiClientOver, selectRecordApiTransport } from './record-api-client.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import {
  forgetRecordIdentityMemo,
  RECORD_IDENTITY_MEMO_MAX_AGE_MS,
} from './record-identity-memo.ts'

const identity = {
  user: {
    id: 'user-a',
    email: 'user@example.test',
    emailVerified: true,
  },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
  memberships: [
    {
      space_id: 'space-a',
      name: 'Alpha',
      slug: 'alpha',
      role: 'owner',
      permission: 'write',
    },
  ],
}

const originalStateHome = process.env[STATE_HOME_ENV]
const originalKeyStore = process.env.BOTTEGA_KEYSTORE
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const originalTestContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
let stateHome = ''

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'record-identity-memo-'))
  process.env[STATE_HOME_ENV] = stateHome
  process.env.BOTTEGA_KEYSTORE = 'file'
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = '1'
  forgetRecordIdentityMemo()
})

afterEach(() => {
  forgetRecordIdentityMemo()
  rmSync(stateHome, { recursive: true, force: true })
  restoreEnvironment('BOTTEGA_KEYSTORE', originalKeyStore)
  restoreEnvironment('BOTTEGA_RECORD_API_URL', originalRecordApiUrl)
  restoreEnvironment('BOTTEGA_TEST_POSTGRES_CONTAINER', originalTestContainer)
  restoreEnvironment(STATE_HOME_ENV, originalStateHome)
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function countingRequest(onWhoami: () => Promise<typeof identity> = async () => identity): {
  request: RecordClientRequest
  whoamiRequests: () => number
} {
  let whoamiRequests = 0
  const request = (async (
    path: string,
    init: RequestInit & { schema?: (body: unknown) => unknown } = {},
  ): Promise<unknown> => {
    if (path === '/v1/whoami') {
      whoamiRequests += 1
      const body = await onWhoami()
      return init.schema ? init.schema(body) : body
    }
    if (path === '/api/auth/organization/set-active' || path === '/api/auth/organization/create') {
      const body = { id: 'space-b', slug: 'beta' }
      return init.schema ? init.schema(body) : body
    }
    if (path === '/api/auth/organization/accept-invitation') {
      const body = { invitation: { organizationId: 'space-b' } }
      return init.schema ? init.schema(body) : body
    }
    throw new Error(`unexpected request ${path}`)
  }) as RecordClientRequest
  return { request, whoamiRequests: () => whoamiRequests }
}

function realClients(request: RecordClientRequest, now: () => number = Date.now) {
  const realRequest = () => selectRecordApiTransport(request, request, now)
  return [recordApiClientOver(realRequest()), recordApiClientOver(realRequest())] as const
}

describe('record identity process memo', () => {
  test('two independently built real-transport clients share one whoami request', async () => {
    const counted = countingRequest()
    const [first, second] = realClients(counted.request)

    await Promise.all([first.whoami(), second.whoami()])

    expect(counted.whoamiRequests()).toBe(1)
  })

  test('a changed session stamp makes the next client re-request whoami', async () => {
    const counted = countingRequest()
    const [first, second] = realClients(counted.request)
    await first.whoami()

    markRecordIdentityChanged()
    await second.whoami()

    expect(counted.whoamiRequests()).toBe(2)
  })

  test('identity older than the maximum age is re-requested without sleeping', async () => {
    let now = 1_000
    const counted = countingRequest()
    const [first, second] = realClients(counted.request, () => now)
    await first.whoami()

    now += RECORD_IDENTITY_MEMO_MAX_AGE_MS + 1
    await second.whoami()

    expect(counted.whoamiRequests()).toBe(2)
  })

  test('a failed whoami is retried instead of memoized', async () => {
    let attempt = 0
    const counted = countingRequest(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('record unavailable')
      return identity
    })
    const [first, second] = realClients(counted.request)

    await expect(first.whoami()).rejects.toThrow('record unavailable')
    await expect(second.whoami()).resolves.toEqual(identity)
    expect(counted.whoamiRequests()).toBe(2)
  })

  test('set-active success invalidates identity before the next whoami', async () => {
    const counted = countingRequest()
    const [first, second] = realClients(counted.request)
    await first.whoami()

    await first.setActiveOrganization({ organizationId: 'space-b' })
    await second.whoami()

    expect(counted.whoamiRequests()).toBe(2)
  })

  test('create-organization success invalidates identity before the next whoami', async () => {
    const counted = countingRequest()
    const [first, second] = realClients(counted.request)
    await first.whoami()

    await first.createOrganization({ name: 'Beta', slug: 'beta' })
    await second.whoami()

    expect(counted.whoamiRequests()).toBe(2)
  })

  test('accept-invitation success invalidates identity before the next whoami', async () => {
    const counted = countingRequest()
    const [first, second] = realClients(counted.request)
    await first.whoami()

    await first.acceptInvitation('invitation-a')
    await second.whoami()

    expect(counted.whoamiRequests()).toBe(2)
  })
})
