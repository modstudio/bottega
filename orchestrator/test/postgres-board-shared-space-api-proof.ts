import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { claimCachedHosted, refreshHostedBoard } from '../src/board/board-hosted-cache.ts'
import { postgresBoardCacheClient, postgresBoardCacheStore } from './postgres-board-cache-client.ts'

export function registerBoardSharedSpaceApiProof(
  origin: () => string,
  sharedToken: () => string,
  unrelatedToken: () => string,
  project: string,
  post: (id: string) => Promise<Response>,
): void {
  test('change feed includes explicit shared-space reach only for a user sharing a space', async () => {
    const id = newRecordId()
    expect((await post(id)).status).toBe(200)
    const changes = async (token: string) =>
      (await (
        await fetch(`${origin()}/v1/board/changes?after=0&limit=100`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { items: Array<{ message: { id: string; sharedSpaceReach?: boolean } }> }
    const shared = await changes(sharedToken())
    expect(shared.items.find((item) => item.message.id === id)?.message.sharedSpaceReach).toBeTrue()
    expect(
      (await changes(unrelatedToken())).items.some((item) => item.message.id === id),
    ).toBeFalse()
  })

  test('stored shared-space messages describe their audience across hosted reads and delivery', async () => {
    const id = newRecordId()
    const replyId = newRecordId()
    const session = 'board-api-spaces-rendered'
    const phrase = 'everyone sharing a space with the author'
    expect((await post(id)).status).toBe(200)
    expect(
      (
        await fetch(`${origin()}/v1/board/messages/${id}/replies`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sharedToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ id: replyId, body: 'shared reply', authorSession: session }),
        })
      ).status,
    ).toBe(200)

    const read = await (
      await fetch(`${origin()}/v1/board/changes?after=0&limit=100`, {
        headers: { authorization: `Bearer ${sharedToken()}` },
      })
    ).json()
    const thread = await (
      await fetch(`${origin()}/v1/board/threads/${id}`, {
        headers: { authorization: `Bearer ${sharedToken()}` },
      })
    ).json()
    const status = await (
      await fetch(`${origin()}/v1/board/messages/${id}/status`, {
        headers: { authorization: `Bearer ${sharedToken()}` },
      })
    ).json()
    const overview = await (
      await fetch(`${origin()}/v1/board/messages`, {
        headers: { authorization: `Bearer ${sharedToken()}` },
      })
    ).json()
    for (const value of [read, thread, status, overview])
      expect(JSON.stringify(value)).toContain(phrase)

    const store = postgresBoardCacheStore(session, project)
    try {
      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { BOTTEGA_RECORD_API_URL: origin() },
          client: postgresBoardCacheClient(origin(), sharedToken()),
          database: store,
        }),
      ).toMatchObject({ status: 'success' })
      const claimed = claimCachedHosted(
        session,
        false,
        Date.parse('2098-01-01T00:00:00.000Z'),
        store,
      )
      expect(claimed.find((message) => message.id === id)?.text).toContain(phrase)
    } finally {
      store.close()
    }
  })
}
