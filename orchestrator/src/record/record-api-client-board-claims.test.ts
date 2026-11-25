import { expect, test } from 'bun:test'
import { recordBoardClaimClient } from './record-api-client-board-claims.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'

test('releaseBoardSessionClaims posts the holder session to the destination space', async () => {
  const calls: Array<{ path: string; init?: RequestInit & { destinationSpaceId?: string } }> = []
  const request = (async (path, init) => {
    calls.push({ path, init })
    return { released: 3 }
  }) as RecordClientRequest
  const client = recordBoardClaimClient(request)

  await expect(
    client.releaseBoardSessionClaims(
      { holderSession: 'session-a' },
      { destinationSpaceId: 'space-a' },
    ),
  ).resolves.toEqual({ released: 3 })
  expect(calls).toEqual([
    {
      path: '/v1/board/claims/release-session',
      init: {
        method: 'POST',
        body: JSON.stringify({ holderSession: 'session-a' }),
        destinationSpaceId: 'space-a',
      },
    },
  ])
})
