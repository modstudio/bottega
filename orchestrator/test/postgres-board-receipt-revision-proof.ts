import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { hostedBoardCursor, refreshHostedBoard } from '../src/board/board-hosted-cache.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'
import { notice as boardNotice, headers, json } from './postgres-board-api-values.ts'

/**
 * An acknowledgement written by another client must reach this machine's receipt cache, and
 * only a first acknowledgement may advance the message revision the change feed pages on.
 */
type ProofInput = {
  origin(): string
  authorToken(): string
  readerToken(): string
  project: string
  projectId: string
  cacheStore(session: string): Database
  cacheClient(token: string): RecordApiClient
  caseSession(label: string): string
  succeeds(user: string, password: string, source: string): string
}

/**
 * The acknowledgement's whole message write is the definer function, so a proof of the refused
 * path pauses that function: it advances no revision, exactly as it would for a caller with no
 * acknowledged receipt, and the acknowledgement must refuse instead of storing a stale receipt.
 */
const pauseAdvanceRevision = `
  ALTER FUNCTION public.board_message_advance_receipt_revision(uuid)
    RENAME TO board_message_advance_receipt_revision_paused;
  CREATE FUNCTION public.board_message_advance_receipt_revision(p_message_id uuid)
    RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
`

const resumeAdvanceRevision = `
  DROP FUNCTION public.board_message_advance_receipt_revision(uuid);
  ALTER FUNCTION public.board_message_advance_receipt_revision_paused(uuid)
    RENAME TO board_message_advance_receipt_revision;
`

export function registerBoardReceiptRevisionProofs(input: ProofInput): void {
  const post = (token: string, body: Record<string, unknown>) =>
    fetch(`${input.origin()}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(body),
    })

  const notice = (id: string, session: string) =>
    boardNotice(id, `project:${input.project}`, session, { projectId: input.projectId })

  const receipt = (token: string, body: Record<string, unknown>) =>
    fetch(`${input.origin()}/v1/board/receipts`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(body),
    })

  const revision = async (token: string, id: string): Promise<string> => {
    const status = await json(
      await fetch(`${input.origin()}/v1/board/messages/${id}/status`, {
        headers: headers(token),
      }),
    )
    return String((status.message as { revision: string }).revision)
  }

  test('an acknowledgement from another client reaches this machine cache through refresh', async () => {
    const session = input.caseSession('ack-other-client')
    const store = input.cacheStore(session)
    try {
      const id = newRecordId()
      expect(
        (await post(input.authorToken(), notice(id, input.caseSession('ack-author')))).status,
      ).toBe(200)
      const client = input.cacheClient(input.readerToken())
      const refresh = () =>
        refreshHostedBoard({
          budgetMs: 2_000,
          env: { BOTTEGA_RECORD_API_URL: input.origin() },
          client,
          database: store,
        })
      expect(await refresh()).toMatchObject({ status: 'success' })
      const cursor = hostedBoardCursor(store)
      expect(
        (
          await receipt(input.readerToken(), {
            messageId: id,
            readerSession: 'ack-other-machine',
            audienceAtPosting: true,
            acknowledged: true,
          })
        ).status,
      ).toBe(200)
      expect(await refresh()).toMatchObject({ status: 'success' })
      const cached = store
        .query(
          'SELECT acknowledged_at FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?',
        )
        .get(id, 'ack-other-machine') as { acknowledged_at: string | null } | null
      expect(cached?.acknowledged_at).not.toBeNull()
      const page = await json(
        await fetch(`${input.origin()}/v1/board/changes?after=${cursor}&limit=100`, {
          headers: headers(input.readerToken()),
        }),
      )
      const items = page.items as Array<{
        message: { id: string }
        receipts: Array<{ readerSession: string; acknowledgedAt: string | null }>
      }>
      expect(
        items
          .find((item) => item.message.id === id)
          ?.receipts.map(
            (row) => `${row.readerSession}:${row.acknowledgedAt === null ? 'unacked' : 'acked'}`,
          ),
      ).toContain('ack-other-machine:acked')
    } finally {
      store.close()
    }
  })

  test('a delivery-only receipt write leaves the message revision alone', async () => {
    const id = newRecordId()
    expect(
      (await post(input.authorToken(), notice(id, input.caseSession('delivery-revision')))).status,
    ).toBe(200)
    const before = await revision(input.authorToken(), id)
    expect(
      (
        await receipt(input.readerToken(), {
          messageId: id,
          readerSession: 'delivery-only-reader',
          audienceAtPosting: true,
          delivered: true,
        })
      ).status,
    ).toBe(200)
    expect(await revision(input.authorToken(), id)).toBe(before)
  })

  test('a repeated acknowledgement does not advance the message revision again', async () => {
    const id = newRecordId()
    expect(
      (await post(input.authorToken(), notice(id, input.caseSession('ack-repeat')))).status,
    ).toBe(200)
    const before = await revision(input.authorToken(), id)
    const acknowledge = () =>
      receipt(input.readerToken(), {
        messageId: id,
        readerSession: 'ack-repeat-reader',
        audienceAtPosting: true,
        delivered: true,
        acknowledged: true,
      })
    expect((await acknowledge()).status).toBe(200)
    const afterFirst = await revision(input.authorToken(), id)
    expect(BigInt(afterFirst) > BigInt(before)).toBeTrue()
    expect((await acknowledge()).status).toBe(200)
    expect(await revision(input.authorToken(), id)).toBe(afterFirst)
  })

  test('an acknowledgement that advances no revision is refused and leaves no receipt stored', async () => {
    const id = newRecordId()
    const reader = input.caseSession('ack-refused-reader')
    expect(
      (await post(input.authorToken(), notice(id, input.caseSession('ack-refused-author')))).status,
    ).toBe(200)
    input.succeeds('postgres', 'postgres', pauseAdvanceRevision)
    try {
      const before = await revision(input.authorToken(), id)
      const refused = await receipt(input.readerToken(), {
        messageId: id,
        readerSession: reader,
        audienceAtPosting: true,
        delivered: true,
        acknowledged: true,
      })
      expect(refused.status).toBe(409)
      expect(String((await json(refused)).error)).toContain('did not advance its revision')
      const status = await json(
        await fetch(`${input.origin()}/v1/board/messages/${id}/status`, {
          headers: headers(input.authorToken()),
        }),
      )
      expect(
        (status.receipts as Array<{ readerSession: string }>).map((row) => row.readerSession),
      ).not.toContain(reader)
      expect(await revision(input.authorToken(), id)).toBe(before)
    } finally {
      input.succeeds('postgres', 'postgres', resumeAdvanceRevision)
    }
  })
}
