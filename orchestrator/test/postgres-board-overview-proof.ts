import { beforeAll, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import type { HostedBoardOverview } from '../src/record/record-board-contract.ts'

type ProofInput = {
  origin(): string
  tokenA(): string
  tokenB(): string
  tokenC(): string
  tokenD(): string
  userA(): string
  userB(): string
  userD(): string
  succeeds(user: string, password: string, source: string): string
  expiresAt: string
  caseSession(label: string): string
}

const IDS = {
  space: '03990000-0000-7000-8000-000000000005',
  project: '03990000-0000-7000-8000-000000000014',
  memberB: '03990000-0000-7000-8000-000000000024',
  memberD: '03990000-0000-7000-8000-000000000025',
  memberA: '03990000-0000-7000-8000-000000000026',
} as const
const PROJECT = 'board-api-overview'

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
})

async function body<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

export function registerBoardOverviewProof(input: ProofInput): void {
  beforeAll(() => {
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO space (id,name,slug,created_at) VALUES
        ('${IDS.space}','Board API overview','board-api-overview',now());
       INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
        ('${IDS.project}','${IDS.space}','${PROJECT}',ARRAY['BAPIO'],now());
       INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
        ('${IDS.memberB}','${IDS.space}','${input.userB()}','member','write',now()),
        ('${IDS.memberD}','${IDS.space}','${input.userD()}','member','read',now()),
        ('${IDS.memberA}','${IDS.space}','${input.userA()}','owner','write',now());`,
    )
  })

  const post = (
    token: string,
    kind: 'notice' | 'question',
    audience: string,
    label: string,
    extra: Record<string, unknown> = {},
  ) => {
    const id = newRecordId()
    return {
      id,
      response: fetch(`${input.origin()}/v1/board/messages`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          id,
          kind,
          audience,
          title: `overview-${label}`,
          body: `body-${label}`,
          expiresAt: input.expiresAt,
          authorSession: input.caseSession(`overview-${label}`),
          ...(audience === `project:${PROJECT}` ? { projectId: IDS.project } : {}),
          ...extra,
        }),
      }),
    }
  }

  const list = async (token: string, query = '') =>
    body<HostedBoardOverview>(
      await fetch(`${input.origin()}/v1/board/messages${query}`, { headers: headers(token) }),
    )

  test('board overview exposes receipt reach only to the notice author', async () => {
    const posted = post(input.tokenA(), 'notice', `project:${PROJECT}`, 'receipt-reach', {
      ackRequired: true,
      ackDeadline: new Date(Date.parse(input.expiresAt) - 1).toISOString(),
      project: PROJECT,
    })
    await body(await posted.response)
    const receipt = (token: string, readerSession: string, acknowledged: boolean) =>
      fetch(`${input.origin()}/v1/board/receipts`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          messageId: posted.id,
          readerSession,
          audienceAtPosting: true,
          delivered: true,
          acknowledged,
        }),
      })
    await body(await receipt(input.tokenB(), 'overview-reader-one', true))
    await body(await receipt(input.tokenD(), 'overview-reader-two', false))

    const authored = (await list(input.tokenA())).messages.find((row) => row.id === posted.id)
    expect(authored).toMatchObject({
      id: posted.id,
      kind: 'notice',
      reached: 2,
      acknowledged: 1,
      unacknowledged: ['overview-reader-two'],
      store: 'hosted',
    })
    const member = (await list(input.tokenB())).messages.find((row) => row.id === posted.id)
    expect(member).toMatchObject({
      id: posted.id,
      reached: null,
      acknowledged: null,
      unacknowledged: null,
    })
    expect((await list(input.tokenC())).messages.some((row) => row.id === posted.id)).toBeFalse()
  })

  test('board overview filters roots before listing and counts visible replies', async () => {
    const audience = 'operator'
    const open = post(input.tokenA(), 'question', audience, 'open-question')
    const accepted = post(input.tokenA(), 'question', audience, 'accepted-question')
    const withdrawn = post(input.tokenA(), 'question', audience, 'withdrawn-question')
    const notice = post(input.tokenA(), 'notice', audience, 'open-notice')
    await Promise.all(
      [open.response, accepted.response, withdrawn.response, notice.response].map(
        async (response) => body(await response),
      ),
    )

    const openReplyId = newRecordId()
    await body(
      await fetch(`${input.origin()}/v1/board/messages/${open.id}/replies`, {
        method: 'POST',
        headers: headers(input.tokenA()),
        body: JSON.stringify({
          id: openReplyId,
          body: 'visible answer',
          authorSession: input.caseSession('overview-open-reply'),
        }),
      }),
    )
    const acceptedReplyId = newRecordId()
    await body(
      await fetch(`${input.origin()}/v1/board/messages/${accepted.id}/replies`, {
        method: 'POST',
        headers: headers(input.tokenA()),
        body: JSON.stringify({
          id: acceptedReplyId,
          body: 'accepted answer',
          authorSession: input.caseSession('overview-accepted-reply'),
        }),
      }),
    )
    await body(
      await fetch(`${input.origin()}/v1/board/messages/${accepted.id}/accept`, {
        method: 'POST',
        headers: headers(input.tokenA()),
        body: JSON.stringify({
          replyId: acceptedReplyId,
          authorSession: input.caseSession('overview-accepted-question'),
        }),
      }),
    )
    await body(
      await fetch(`${input.origin()}/v1/board/messages/${withdrawn.id}/withdraw`, {
        method: 'POST',
        headers: headers(input.tokenA()),
        body: JSON.stringify({
          authorSession: input.caseSession('overview-withdrawn-question'),
        }),
      }),
    )

    const liveOpen = await list(input.tokenA(), '?open=true')
    const openEntry = liveOpen.messages.find((row) => row.id === open.id)
    expect(openEntry).toMatchObject({
      id: open.id,
      kind: 'question',
      replyCount: 1,
      acceptedReplyId: null,
    })
    expect(liveOpen.messages.some((row) => row.id === accepted.id)).toBeFalse()
    expect(liveOpen.messages.some((row) => row.id === notice.id)).toBeFalse()
    expect(liveOpen.messages.some((row) => row.id === withdrawn.id)).toBeFalse()
    expect(liveOpen.messages.some((row) => row.id === openReplyId)).toBeFalse()

    const withEnded = await list(input.tokenA(), '?open=true&includeEnded=true')
    expect(withEnded.messages.some((row) => row.id === withdrawn.id)).toBeTrue()
    expect(withEnded.messages.some((row) => row.id === accepted.id)).toBeFalse()
  })

  test('board overview owner title prefix is literal and excludes ended notices', async () => {
    const prefix = 'Hosted pressure: cpu%_'
    const matching = post(input.tokenA(), 'notice', 'operator', 'pressure-literal', {
      title: `${prefix} steal=0.25`,
    })
    const overmatch = post(input.tokenA(), 'notice', 'operator', 'pressure-overmatch', {
      title: 'Hosted pressure: cpuXX steal=0.25',
    })
    const otherOwner = post(input.tokenB(), 'notice', 'operator', 'pressure-other-owner', {
      title: `${prefix} api-p95=3s`,
    })
    const withdrawn = post(input.tokenA(), 'notice', 'operator', 'pressure-withdrawn', {
      title: `${prefix} withdrawn`,
    })
    const expired = post(input.tokenA(), 'notice', 'operator', 'pressure-expired', {
      title: `${prefix} expired`,
    })
    await Promise.all(
      [matching, overmatch, otherOwner, withdrawn, expired].map(async (item) =>
        body(await item.response),
      ),
    )
    await body(
      await fetch(`${input.origin()}/v1/board/messages/${withdrawn.id}/withdraw`, {
        method: 'POST',
        headers: headers(input.tokenA()),
        body: JSON.stringify({ authorSession: input.caseSession('overview-prefix-withdraw') }),
      }),
    )
    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE board_message SET expires_at=now() - interval '1 second' WHERE id='${expired.id}';`,
    )

    const filtered = await list(
      input.tokenA(),
      `?kind=notice&ownTitlePrefix=${encodeURIComponent(prefix)}`,
    )
    expect(filtered.messages.map((row) => row.id)).toEqual([matching.id])
  })
}
