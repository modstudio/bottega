import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  claimCachedHosted,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from '../src/board/board-hosted-cache.ts'
import { expiresAt, headers, json } from './postgres-board-api-values.ts'
import { postgresBoardCacheClient, postgresBoardCacheStore } from './postgres-board-cache-client.ts'

export function registerBoardReplyProof(input: {
  origin: () => string
  token: () => string
  project: string
  caseSession: (label: string) => string
}): void {
  test('a reply loops a new session into the hosted thread and later participant replies', async () => {
    const rootId = newRecordId()
    const directId = newRecordId()
    const participantId = newRecordId()
    const loopedSession = input.caseSession('reply-looped')
    const store = postgresBoardCacheStore(loopedSession, input.project)
    const client = postgresBoardCacheClient(input.origin(), input.token())
    const reply = (id: string, body: string, audience: string, authorSession: string) =>
      fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
        method: 'POST',
        headers: headers(input.token()),
        body: JSON.stringify({ id, body, audience, authorSession }),
      })
    try {
      const posted = await fetch(`${input.origin()}/v1/board/messages`, {
        method: 'PUT',
        headers: headers(input.token()),
        body: JSON.stringify({
          id: rootId,
          kind: 'notice',
          audience: 'operator',
          title: 'Loop in a session',
          body: 'Root body',
          expiresAt,
          authorSession: input.caseSession('reply-loop-root'),
        }),
      })
      expect(posted.status).toBe(200)
      expect(
        (
          await reply(
            directId,
            'Join this thread',
            `session:${loopedSession}`,
            input.caseSession('reply-loop-author'),
          )
        ).status,
      ).toBe(200)
      await refreshHostedBoard({ budgetMs: 2_000, client, database: store })
      const directlyReceived = claimCachedHosted(
        loopedSession,
        false,
        Date.parse('2098-01-01T00:00:00.000Z'),
        store,
      )
      expect(directlyReceived.map((message) => message.id)).toEqual([directId])
      expect(directlyReceived[0]?.text).toContain(rootId)
      await markCachedHostedDelivered(loopedSession, [directId], { client, database: store })

      expect(
        (
          await reply(
            participantId,
            'All participants receive this',
            'participants',
            input.caseSession('reply-loop-later-author'),
          )
        ).status,
      ).toBe(200)
      await refreshHostedBoard({ budgetMs: 2_000, client, database: store })
      expect(
        claimCachedHosted(loopedSession, false, Date.parse('2098-01-01T00:00:00.000Z'), store).map(
          (message) => message.id,
        ),
      ).toEqual([participantId])
      const thread = await fetch(`${input.origin()}/v1/board/threads/${rootId}`, {
        headers: headers(input.token()),
      })
      expect(thread.status).toBe(200)
      expect((await json(thread)).replies).toHaveLength(2)
    } finally {
      store.close()
    }
  })
}
