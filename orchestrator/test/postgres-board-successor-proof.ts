import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { headers, json, notice } from './postgres-board-api-values.ts'

type Input = {
  origin(): string
  authorToken(): string
  readerToken(): string
  otherSpaceToken(): string
  project: string
  projectId: string
  spaceId(): string
  succeeds(user: string, password: string, source: string): string
}

export function registerBoardSuccessorProofs(input: Input): void {
  const presence = async (token: string, rows: Array<{ session: string; lastSeen: string }>) => {
    const value = rows.map((row) => ({
      ...row,
      projectId: input.projectId,
      role: 'architect',
      firstSeen: row.lastSeen,
    }))
    return fetch(
      `${input.origin()}/v1/board/changes?after=0&presence=${encodeURIComponent(JSON.stringify(value))}`,
      { headers: headers(token) },
    )
  }
  const elect = (token: string, messageId: string, candidateSession: string) =>
    fetch(`${input.origin()}/v1/board/successor`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ messageId, candidateSession }),
    })
  const revision = async (token: string, messageId: string) => {
    const status = await json(
      await fetch(`${input.origin()}/v1/board/messages/${messageId}/status`, {
        headers: headers(token),
      }),
    )
    return String((status.message as { revision: string }).revision)
  }
  const thread = async (authorSession: string) => {
    const rootId = newRecordId()
    const replyId = newRecordId()
    expect(
      (
        await fetch(`${input.origin()}/v1/board/messages`, {
          method: 'PUT',
          headers: headers(input.authorToken()),
          body: JSON.stringify(
            notice(rootId, `project:${input.project}`, authorSession, {
              project: input.project,
              projectId: input.projectId,
            }),
          ),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
          method: 'POST',
          headers: headers(input.authorToken()),
          body: JSON.stringify({ id: replyId, body: 'report reply', authorSession: 'replier' }),
        })
      ).status,
    ).toBe(200)
    return { rootId, replyId }
  }

  test('two concurrent hosted successor elections produce one holder', async () => {
    const { replyId } = await thread('gone-author')
    const before = await revision(input.authorToken(), replyId)
    const now = new Date().toISOString()
    expect(
      (
        await presence(input.readerToken(), [
          { session: 'successor-one', lastSeen: now },
          { session: 'successor-two', lastSeen: now },
        ])
      ).status,
    ).toBe(200)
    const results = await Promise.all([
      elect(input.readerToken(), replyId, 'successor-one').then(json),
      elect(input.readerToken(), replyId, 'successor-two').then(json),
    ])
    // readerToken's active space differs from the root project's space, but its user is a member.
    expect(results.filter((row) => row.elected === true)).toHaveLength(1)
    expect(new Set(results.map((row) => row.holder)).size).toBe(1)
    expect(BigInt(await revision(input.authorToken(), replyId)) > BigInt(before)).toBeTrue()
    const electedHolder = results.find((row) => row.elected === true)?.holder as string
    const changes = await json(
      await fetch(`${input.origin()}/v1/board/changes?after=${before}&limit=100`, {
        headers: headers(input.readerToken()),
      }),
    )
    const items = changes.items as Array<{
      message: { id: string }
      receipts: Array<{ readerSession: string; successor: boolean }>
    }>
    const successorReceipts =
      items.find((item) => item.message.id === replyId)?.receipts.filter((row) => row.successor) ??
      []
    expect(successorReceipts).toHaveLength(1)
    expect(successorReceipts[0]?.readerSession).toBe(electedHolder)
  })

  test('hosted successor election applies liveness, delivery, eligibility and cross-user replacement', async () => {
    const now = new Date().toISOString()
    const liveAuthor = await thread('live-author')
    await presence(input.authorToken(), [{ session: 'live-author', lastSeen: now }])
    await presence(input.readerToken(), [{ session: 'live-author-candidate', lastSeen: now }])
    const liveBefore = await revision(input.authorToken(), liveAuthor.replyId)
    expect(
      await json(await elect(input.readerToken(), liveAuthor.replyId, 'live-author-candidate')),
    ).toEqual({ elected: false, holder: null })
    expect(await revision(input.authorToken(), liveAuthor.replyId)).toBe(liveBefore)

    const delivered = await thread('delivered-root')
    await presence(input.readerToken(), [{ session: 'delivered-holder', lastSeen: now }])
    expect(
      await json(await elect(input.readerToken(), delivered.replyId, 'delivered-holder')),
    ).toEqual({ elected: true, holder: 'delivered-holder' })
    expect(
      (
        await fetch(`${input.origin()}/v1/board/receipts`, {
          method: 'PUT',
          headers: headers(input.readerToken()),
          body: JSON.stringify({
            messageId: delivered.replyId,
            readerSession: 'delivered-holder',
            audienceAtPosting: false,
            delivered: true,
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      await json(await elect(input.readerToken(), delivered.replyId, 'later-candidate')),
    ).toEqual({ elected: false, holder: 'delivered-holder' })

    const ineligible = await thread('ineligible-root')
    expect(
      await json(await elect(input.readerToken(), ineligible.replyId, 'missing-presence')),
    ).toEqual({ elected: false, holder: null })

    const replacement = await thread('replacement-root')
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const oldHolder = `old-holder-${newRecordId()}`
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO board_presence
         (id,space_id,user_id,session,project_id,role,first_seen,last_seen)
       SELECT gen_random_uuid(),'${input.spaceId()}',author_user_id,'${oldHolder}',
         '${input.projectId}','architect','${stale}','${stale}'
       FROM board_message WHERE id='${replacement.rootId}';
       INSERT INTO board_receipt
         (id,message_id,reader_user_id,reader_session,audience_at_posting,successor)
       SELECT gen_random_uuid(),'${replacement.replyId}',author_user_id,'${oldHolder}',false,true
       FROM board_message WHERE id='${replacement.rootId}';`,
    )
    const replacementCandidate = `replacement-${newRecordId()}`
    await presence(input.readerToken(), [{ session: replacementCandidate, lastSeen: now }])
    expect(
      await json(await elect(input.readerToken(), replacement.replyId, replacementCandidate)),
    ).toEqual({ elected: true, holder: replacementCandidate })
    expect(
      input.succeeds(
        'postgres',
        'postgres',
        `SELECT count(*) || '|' || min(reader_session)
         FROM board_receipt WHERE message_id='${replacement.replyId}' AND successor;`,
      ),
    ).toBe(`1|${replacementCandidate}`)
  })

  test('only delivery to the root author session blocks hosted successor election', async () => {
    const now = new Date().toISOString()
    const received = await thread('receiving-author')
    await presence(input.readerToken(), [{ session: 'received-candidate', lastSeen: now }])
    expect(
      (
        await fetch(`${input.origin()}/v1/board/receipts`, {
          method: 'PUT',
          headers: headers(input.authorToken()),
          body: JSON.stringify({
            messageId: received.replyId,
            readerSession: 'receiving-author',
            audienceAtPosting: false,
            delivered: true,
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      await json(await elect(input.readerToken(), received.replyId, 'received-candidate')),
    ).toEqual({ elected: false, holder: null })

    const otherSession = await thread('offline-author')
    await presence(input.readerToken(), [{ session: 'other-session-candidate', lastSeen: now }])
    expect(
      (
        await fetch(`${input.origin()}/v1/board/receipts`, {
          method: 'PUT',
          headers: headers(input.authorToken()),
          body: JSON.stringify({
            messageId: otherSession.replyId,
            readerSession: 'same-user-other-session',
            audienceAtPosting: false,
            delivered: true,
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      await json(await elect(input.readerToken(), otherSession.replyId, 'other-session-candidate')),
    ).toEqual({ elected: true, holder: 'other-session-candidate' })
  })

  test('another tenant cannot elect a successor for the reply', async () => {
    const { replyId } = await thread('tenant-author')
    const candidate = `other-space-${newRecordId()}`
    const now = new Date().toISOString()
    expect(
      (await presence(input.otherSpaceToken(), [{ session: candidate, lastSeen: now }])).status,
    ).toBe(200)
    expect((await elect(input.otherSpaceToken(), replyId, candidate)).status).toBe(404)
    expect(
      input
        .succeeds(
          'postgres',
          'postgres',
          `SELECT count(*) FROM board_receipt WHERE message_id='${replyId}' AND successor;`,
        )
        .trim(),
    ).toBe('0')
  })

  test('hosted presence writes at most once per interval', async () => {
    const session = `presence-interval-${newRecordId()}`
    const first = new Date(Date.now() - 10_000).toISOString()
    const second = new Date().toISOString()
    expect((await presence(input.readerToken(), [{ session, lastSeen: first }])).status).toBe(200)
    expect((await presence(input.readerToken(), [{ session, lastSeen: second }])).status).toBe(200)
    const stored = input.succeeds(
      'postgres',
      'postgres',
      `SELECT last_seen::text FROM board_presence WHERE session='${session}';`,
    )
    expect(stored).toContain(first.slice(0, 19).replace('T', ' '))
  })

  test('board presence is tenant isolated', async () => {
    const session = `presence-tenant-${newRecordId()}`
    const now = new Date().toISOString()
    expect((await presence(input.readerToken(), [{ session, lastSeen: now }])).status).toBe(200)
    expect((await presence(input.otherSpaceToken(), [{ session, lastSeen: now }])).status).toBe(200)
    const spaces = input.succeeds(
      'postgres',
      'postgres',
      `SELECT count(DISTINCT space_id) FROM board_presence WHERE session='${session}';`,
    )
    expect(spaces.trim()).toBe('2')
  })

  test('presence prune removes stale rows across spaces and keeps live rows', async () => {
    const prefix = `presence-prune-${newRecordId()}`
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const live = new Date().toISOString()
    for (const token of [input.readerToken(), input.otherSpaceToken()]) {
      expect(
        (
          await presence(token, [
            { session: `${prefix}-stale-${token.slice(-4)}`, lastSeen: stale },
            { session: `${prefix}-live-${token.slice(-4)}`, lastSeen: live },
          ])
        ).status,
      ).toBe(200)
    }
    input.succeeds(
      'postgres',
      'postgres',
      `BEGIN; SET LOCAL ROLE record_actor; SELECT public.board_presence_prune(); COMMIT;`,
    )
    expect(
      input.succeeds(
        'postgres',
        'postgres',
        `SELECT count(*) FILTER (WHERE session LIKE '${prefix}-stale-%') || '|' ||
                count(*) FILTER (WHERE session LIKE '${prefix}-live-%')
         FROM board_presence;`,
      ),
    ).toBe('0|2')
  })
}
