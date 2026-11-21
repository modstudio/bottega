import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configClient } from '../../../shared/config-client.ts'
import { forgetConfigReadMemo } from '../../../shared/config-read-memo.ts'
import { markRecordIdentityChanged } from '../../../shared/record-session.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { recordApiClient } from './record-api-client.ts'

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
const originalNodeEnv = process.env.NODE_ENV
let stateHome = ''
let server: ReturnType<typeof Bun.serve>
let session: ReturnType<typeof memoryRecordSession>
let whoamiRequests = 0
let rejectSetActiveResponse = false

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'record-identity-memo-'))
  process.env[STATE_HOME_ENV] = stateHome
  process.env.BOTTEGA_KEYSTORE = 'keychain'
  process.env.NODE_ENV = 'development'
  process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = '1'
  session = memoryRecordSession()
  session.setToken('record-identity-memo-token')
  installRecordSessionRunner(session.runner)
  installRecordApiClient(null)
  whoamiRequests = 0
  rejectSetActiveResponse = false
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/whoami') {
        whoamiRequests += 1
        return Response.json(identity)
      }
      if (path === '/api/auth/organization/set-active' && rejectSetActiveResponse)
        return Response.json({ id: 'space-b' })
      if (path === '/api/auth/organization/set-active' || path === '/api/auth/organization/create')
        return Response.json({ id: 'space-b', slug: 'beta' })
      if (path === '/api/auth/organization/accept-invitation')
        return Response.json({ invitation: { organizationId: 'space-b' } })
      return Response.json({ error: `unexpected request ${path}` }, { status: 404 })
    },
  })
  process.env.BOTTEGA_RECORD_API_URL = server.url.origin
  forgetConfigReadMemo()
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  forgetConfigReadMemo()
  server.stop(true)
  installRecordSessionRunner(null)
  installRecordApiClient(createMemoryRecordApiClient())
  rmSync(stateHome, { recursive: true, force: true })
  restoreEnvironment('BOTTEGA_KEYSTORE', originalKeyStore)
  restoreEnvironment('BOTTEGA_RECORD_API_URL', originalRecordApiUrl)
  restoreEnvironment('BOTTEGA_TEST_POSTGRES_CONTAINER', originalTestContainer)
  restoreEnvironment('NODE_ENV', originalNodeEnv)
  restoreEnvironment(STATE_HOME_ENV, originalStateHome)
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('record identity process memo', () => {
  test('two independently built real-transport clients share one whoami request', async () => {
    const first = recordApiClient()
    const second = recordApiClient()

    await Promise.all([first.whoami(), second.whoami()])

    expect(whoamiRequests).toBe(1)
  })

  test('record and config clients share the same identity read', async () => {
    const record = recordApiClient()
    const config = configClient(process.env)

    await Promise.all([record.whoami(), config.whoami()])

    expect(whoamiRequests).toBe(1)
  })

  test('a changed session stamp makes the next client re-request whoami', async () => {
    const first = recordApiClient()
    const second = recordApiClient()
    await first.whoami()

    markRecordIdentityChanged()
    await second.whoami()

    expect(whoamiRequests).toBe(2)
  })

  test('set-active success invalidates identity before the next whoami', async () => {
    const first = recordApiClient()
    const second = recordApiClient()
    await first.whoami()

    await first.setActiveOrganization({ organizationId: 'space-b' })
    await second.whoami()

    expect(whoamiRequests).toBe(2)
  })

  test('set-active schema failure invalidates identity before the next whoami', async () => {
    const first = recordApiClient()
    const second = recordApiClient()
    await first.whoami()
    rejectSetActiveResponse = true

    await expect(first.setActiveOrganization({ organizationId: 'space-b' })).rejects.toThrow(
      'record API returned an invalid organization',
    )
    await second.whoami()

    expect(whoamiRequests).toBe(2)
  })
})
