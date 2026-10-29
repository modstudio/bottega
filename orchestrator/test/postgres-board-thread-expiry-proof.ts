import { expect, test } from 'bun:test'
import { BOARD_INFORMATION_DEFAULT_EXPIRY_MS } from '../../shared/board-duration.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { expiresAt, headers, json } from './postgres-board-api-values.ts'

export function registerBoardThreadExpiryProofs(input: {
  origin: () => string
  token: () => string
  caseSession: (label: string) => string
}): void {
  const postRoot = (id: string, expiry: string, label: string) =>
    fetch(`${input.origin()}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(input.token()),
      body: JSON.stringify({
        id,
        kind: 'notice',
        audience: 'operator',
        title: 'Thread expiry proof',
        body: 'Root body',
        expiresAt: expiry,
        authorSession: input.caseSession(label),
      }),
    })

  const reply = (rootId: string, id: string, label: string) =>
    fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
      method: 'POST',
      headers: headers(input.token()),
      body: JSON.stringify({
        id,
        body: 'Extend this thread',
        authorSession: input.caseSession(label),
      }),
    })

  const rootState = async (id: string): Promise<[number, string]> => {
    const status = await json(
      await fetch(`${input.origin()}/v1/board/messages/${id}/status`, {
        headers: headers(input.token()),
      }),
    )
    const message = status.message as { expiresAt: string; revision: string }
    return [Date.parse(message.expiresAt), message.revision]
  }

  test('a hosted reply extends a short-lived root and advances its revision', async () => {
    const rootId = newRecordId()
    const replyId = newRecordId()
    const replyTime = Date.now()
    expect(
      (await postRoot(rootId, new Date(replyTime + 60 * 60 * 1000).toISOString(), 'expiry-root'))
        .status,
    ).toBe(200)
    const before = await rootState(rootId)
    expect((await reply(rootId, replyId, 'expiry-reply')).status).toBe(200)
    const after = await rootState(rootId)
    expect(after[0]).toBeGreaterThanOrEqual(replyTime + BOARD_INFORMATION_DEFAULT_EXPIRY_MS)
    expect(BigInt(after[1]) > BigInt(before[1])).toBeTrue()
  })

  test('a hosted reply succeeds when the root already expires beyond seven days', async () => {
    const rootId = newRecordId()
    const replyId = newRecordId()
    expect((await postRoot(rootId, expiresAt, 'long-expiry-root')).status).toBe(200)
    const before = await rootState(rootId)
    expect((await reply(rootId, replyId, 'long-expiry-reply')).status).toBe(200)
    expect(await rootState(rootId)).toEqual(before)
  })
}
