import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'

const DESTINATION_SPACE_ID = '01990000-0000-7000-8000-000000000099'
const CAPTURED = Symbol('captured record request')

type CapturedRequest = { path: string; init: RequestInit & { destinationSpaceId?: string } }

function universalArgument(): object {
  const target = { destinationSpaceId: DESTINATION_SPACE_ID }
  return new Proxy(target, {
    get(object, property) {
      if (property === Symbol.toPrimitive) return () => 'fixture'
      if (property === Symbol.iterator) return function* () {}
      if (property === 'toJSON') return () => ({ destinationSpaceId: DESTINATION_SPACE_ID })
      if (property === 'then') return undefined
      return Reflect.get(object, property) ?? universalArgument()
    },
  })
}

function exemptWrite(method: string, path: string): boolean {
  if (path.startsWith('/api/auth/')) return true
  return new Set([
    'PUT /v1/active-space',
    'PUT /v1/machine/name',
    'POST /v1/machine/retire',
    'POST /v1/spaces/delete',
    'POST /v1/spaces/delete-trial',
    'POST /v1/sync',
  ]).has(`${method} ${path}`)
}

test('every CLI record client write method sends its required destination space', async () => {
  const previousEnv = process.env.NODE_ENV
  const previousFetch = globalThis.fetch
  const captured: CapturedRequest[] = []
  const capture = (path: string, init: CapturedRequest['init'] = {}) => {
    captured.push({ path, init })
    throw CAPTURED
  }
  const request = capture as RecordClientRequest
  installRecordApiClient(null)
  process.env.NODE_ENV = 'development'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    capture(new URL(request.url).pathname, { ...init, method: request.method })
  }) as unknown as typeof fetch

  try {
    const client = recordApiClient(request)
    const argument = universalArgument()
    const unobserved: string[] = []
    for (const [name, method] of Object.entries(client)) {
      const before = captured.length
      try {
        await Reflect.apply(method, client, [argument, argument, argument, argument])
      } catch {
        // The capture sentinel deliberately stops each method at its first transport call.
      }
      if (captured.length === before) unobserved.push(name)
    }

    expect(unobserved).toEqual(['openBoardStream'])
    for (const { path, init } of captured) {
      const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
      if (method === 'GET' || method === 'HEAD' || exemptWrite(method, path)) continue
      const destination =
        typeof init.destinationSpaceId === 'string'
          ? init.destinationSpaceId
          : (init.destinationSpaceId as unknown as { destinationSpaceId?: string } | undefined)
              ?.destinationSpaceId
      expect(destination, `${method} ${path}`).toBe(DESTINATION_SPACE_ID)
    }
  } finally {
    globalThis.fetch = previousFetch
    process.env.NODE_ENV = previousEnv
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
