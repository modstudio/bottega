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
  succeeds(user: string, password: string, source: string): string
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
    const conflictBody = JSON.stringify(await conflict.json())
    expect(conflictBody).toContain(input.userA())
    expect(conflictBody).toContain('release claim')
    expect(conflictBody).toContain('wait for lapse')
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
    const sameHolderLapsedId = newRecordId()
    expect(
      (
        await take(input.tokenA(), {
          id: sameHolderLapsedId,
          project: input.project,
          projectId: input.projectId,
          subject: 'task:BAPI-2',
          holderSession: 'holder-a',
          durationMs: 1,
        })
      ).status,
    ).toBe(200)
    await Bun.sleep(20)
    const sameHolderSuccessor = newRecordId()
    const sameHolderTakeover = await take(input.tokenA(), {
      id: sameHolderSuccessor,
      project: input.project,
      projectId: input.projectId,
      subject: 'task:BAPI-2',
      holderSession: 'holder-a',
    })
    expect(sameHolderTakeover.status).toBe(200)
    expect((await json(sameHolderTakeover)).action).toBe('taken')
    const afterSameHolderTakeover = await json(
      await fetch(
        `${input.origin()}/v1/board/claims?project=${input.project}&projectId=${input.projectId}`,
        { headers: headers(input.tokenA()) },
      ),
    )
    const sameHolderClaims = afterSameHolderTakeover.claims as Array<{
      id: string
      closeReason: string | null
      supersededByClaimId: string | null
      previousClaimIds: string[]
    }>
    expect(sameHolderClaims.find((claim) => claim.id === sameHolderLapsedId)).toMatchObject({
      closeReason: 'lapsed',
      supersededByClaimId: sameHolderSuccessor,
    })
    expect(
      sameHolderClaims.find((claim) => claim.id === sameHolderSuccessor)?.previousClaimIds,
    ).toContain(sameHolderLapsedId)
    const afterSameHolderNotices = await json(
      await fetch(`${input.origin()}/v1/board/changes?after=0&limit=100`, {
        headers: headers(input.tokenA()),
      }),
    )
    expect(
      (
        afterSameHolderNotices.items as Array<{
          message: { audience: string; claimId: string | null }
        }>
      ).some(
        (item) =>
          item.message.audience === 'session:holder-a' &&
          item.message.claimId === sameHolderLapsedId,
      ),
    ).toBeFalse()
    input.succeeds(
      'postgres',
      'postgres',
      `CREATE SEQUENCE board_claim_retry_once;
       CREATE FUNCTION fail_board_claim_insert_once() RETURNS trigger
       LANGUAGE plpgsql SECURITY DEFINER AS $$
       BEGIN
         IF NEW.subject_kind='task' AND NEW.subject_value='BAPI-3'
            AND nextval('board_claim_retry_once')=1 THEN
           RAISE EXCEPTION 'injected board claim collision'
             USING ERRCODE='23505', CONSTRAINT='board_claim_live_subject_unique';
         END IF;
         RETURN NEW;
       END $$;
       CREATE TRIGGER board_claim_retry_once
       BEFORE INSERT ON board_claim FOR EACH ROW EXECUTE FUNCTION fail_board_claim_insert_once();`,
    )
    try {
      const retried = await take(input.tokenA(), {
        id: newRecordId(),
        project: input.project,
        projectId: input.projectId,
        subject: 'task:BAPI-3',
        holderSession: 'holder-a',
      })
      expect(retried.status).toBe(200)
      expect((await json(retried)).action).toBe('taken')
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DROP TRIGGER board_claim_retry_once ON board_claim;
         DROP FUNCTION fail_board_claim_insert_once();
         DROP SEQUENCE board_claim_retry_once;`,
      )
    }
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
