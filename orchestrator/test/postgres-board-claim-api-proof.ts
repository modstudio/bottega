import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { headers, json } from './postgres-board-api-values.ts'

export function registerBoardClaimApiProof(input: {
  origin(): string
  tokenA(): string
  tokenB(): string
  userA(): string
  project: string
  projectId: string
}): void {
  test('claim take, renewal, live conflict with notice, lapsed takeover, release, and release by task key', async () => {
    const take = (token: string, body: Record<string, unknown>) =>
      fetch(`${input.origin()}/v1/board/claims`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify(body),
      })
    const liveId = newRecordId()
    const taken = await take(input.tokenA(), {
      id: liveId,
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:gpu',
      holderSession: 'holder-a',
      durationMs: 60_000,
    })
    expect(taken.status).toBe(200)
    expect((await json(taken)).action).toBe('taken')
    const renewed = await fetch(`${input.origin()}/v1/board/claims/${liveId}/renew`, {
      method: 'POST',
      headers: headers(input.tokenA()),
      body: JSON.stringify({ holderSession: 'holder-a' }),
    })
    expect(renewed.status).toBe(200)
    const conflict = await take(input.tokenB(), {
      id: newRecordId(),
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:gpu',
      holderSession: 'holder-b',
    })
    expect(conflict.status).toBe(409)
    expect(JSON.stringify(await conflict.json())).toContain(input.userA())
    const notices = await json(
      await fetch(`${input.origin()}/v1/board/changes?after=0&limit=100`, {
        headers: headers(input.tokenA()),
      }),
    )
    const told = (
      notices.items as Array<{ message: { audience: string; claimId: string | null } }>
    ).some(
      (item) => item.message.audience === 'session:holder-a' && item.message.claimId === liveId,
    )
    expect(told).toBeTrue()
    const lapsedId = newRecordId()
    const short = await take(input.tokenA(), {
      id: lapsedId,
      project: input.project,
      projectId: input.projectId,
      subject: 'task:BAPI-1',
      holderSession: 'holder-a',
      durationMs: 1,
    })
    expect(short.status).toBe(200)
    await Bun.sleep(20)
    const successor = newRecordId()
    const takeover = await take(input.tokenB(), {
      id: successor,
      project: input.project,
      projectId: input.projectId,
      subject: 'task:BAPI-1',
      holderSession: 'holder-b',
    })
    expect(takeover.status).toBe(200)
    expect((await json(takeover)).action).toBe('taken-over')
    const listed = await json(
      await fetch(
        `${input.origin()}/v1/board/claims?project=${input.project}&projectId=${input.projectId}`,
        { headers: headers(input.tokenA()) },
      ),
    )
    const claims = listed.claims as Array<{
      id: string
      closeReason: string | null
      supersededByClaimId: string | null
      previousClaimIds: string[]
    }>
    const old = claims.find((claim) => claim.id === lapsedId)
    expect(old?.closeReason).toBe('lapsed')
    expect(old?.supersededByClaimId).toBe(successor)
    expect(claims.find((claim) => claim.id === successor)?.previousClaimIds).toContain(lapsedId)
    const released = await fetch(`${input.origin()}/v1/board/claims/${liveId}/release`, {
      method: 'POST',
      headers: headers(input.tokenA()),
      body: JSON.stringify({ holderSession: 'holder-a' }),
    })
    expect(released.status).toBe(200)
    const taskId = newRecordId()
    expect(
      (
        await take(input.tokenA(), {
          id: taskId,
          project: input.project,
          projectId: input.projectId,
          subject: 'task:BAPI-9',
          holderSession: 'holder-a',
        })
      ).status,
    ).toBe(200)
    const byTask = await fetch(`${input.origin()}/v1/board/claims/release-task`, {
      method: 'POST',
      headers: headers(input.tokenA()),
      body: JSON.stringify({
        project: input.project,
        projectId: input.projectId,
        key: 'BAPI-9',
      }),
    })
    expect(byTask.status).toBe(200)
    expect((await json(byTask)).released).toBe(1)
  })
}
