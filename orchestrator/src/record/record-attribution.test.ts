import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { signedInRecordUserId } from './record-attribution.ts'

let priorApiUrl: string | undefined
let priorDirectUrl: string | undefined
let session: ReturnType<typeof memoryRecordSession>

beforeEach(() => {
  priorApiUrl = process.env.ORCH_RECORD_API_URL
  priorDirectUrl = process.env.ORCH_RECORD_URL
  process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
  delete process.env.ORCH_RECORD_URL
  session = memoryRecordSession()
  installRecordSessionRunner(session.runner)
})

afterEach(() => {
  installRecordSessionRunner(null)
  if (priorApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorApiUrl
  if (priorDirectUrl === undefined) delete process.env.ORCH_RECORD_URL
  else process.env.ORCH_RECORD_URL = priorDirectUrl
})

describe('run attribution identity resolution', () => {
  test('uses the record API with a stored session and no direct record URL', async () => {
    session.setToken('fixture-session')

    expect(await signedInRecordUserId()).toBe('01990000-0000-7000-8000-000000000001')
    expect(process.env.ORCH_RECORD_URL).toBeUndefined()
  })

  test('returns null without a stored session', async () => {
    const readOnly = new Database(process.env.ORCH_DB!, { readonly: true })
    expect(await signedInRecordUserId(readOnly)).toBeNull()
    readOnly.close()
  })

  test('resolves a stored session without writing through a read-only handle', async () => {
    session.setToken('fixture-session')
    const readOnly = new Database(process.env.ORCH_DB!, { readonly: true })

    expect(await signedInRecordUserId(readOnly)).toBe('01990000-0000-7000-8000-000000000001')
    readOnly.close()
  })

  test('returns null for an unreachable API', async () => {
    session.setToken('fixture-session')
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      whoami: async () => {
        throw new Error('connection refused')
      },
    })

    expect(await signedInRecordUserId()).toBeNull()
  })

  test('does not require ORCH_RECORD_URL when the API resolves the user', async () => {
    session.setToken('fixture-session')
    delete process.env.ORCH_RECORD_URL

    expect(await signedInRecordUserId()).not.toBeNull()
  })
})
