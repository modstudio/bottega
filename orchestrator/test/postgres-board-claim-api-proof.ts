import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { json, headers as requestHeaders } from './postgres-board-api-values.ts'

export function registerBoardClaimApiProof(input: {
  origin(): string
  spaceIdForToken(token: string): string
  tokenA(): string
  tokenB(): string
  userA(): string
  project: string
  projectId: string
  succeeds(user: string, password: string, source: string): string
}): void {
  const headers = (token: string) => requestHeaders(token, input.spaceIdForToken(token))
  const seedOwnedTaskStage = (key: string, session: string) => {
    const ids = {
      machine: newRecordId(),
      workflow: newRecordId(),
      workflowVersion: newRecordId(),
      catalogue: newRecordId(),
      catalogueVersion: newRecordId(),
      flow: newRecordId(),
      stage: newRecordId(),
    }
    const space = input.spaceIdForToken(input.tokenA())
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO machine (id,user_id,name,registered_at,last_seen)
         VALUES ('${ids.machine}','${input.userA()}','board-claim-task-stage',now(),now());
       INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
         VALUES ('${ids.workflow}','${space}','claim-${ids.workflow}',now(),now());
       INSERT INTO workflow_version
         (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
         VALUES ('${ids.workflowVersion}','${space}','${ids.workflow}',1,'production','{}','test','proof',now(),now());
       INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
         VALUES ('${ids.catalogue}','${space}','claim-${ids.catalogue}',now(),now());
       INSERT INTO step_catalogue_version
         (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
         VALUES ('${ids.catalogueVersion}','${space}','${ids.catalogue}',1,'production','{}','test','proof',now(),now());
       INSERT INTO task_flow
         (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
         VALUES ('${ids.flow}','${space}','${input.projectId}','open','${ids.machine}','${ids.machine}',1,now(),now());
       INSERT INTO task_flow_stage
         (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
          workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
          closed_step_notes,total_steps,opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
         VALUES ('${ids.stage}','${space}','${ids.flow}','${input.projectId}',
          (SELECT COALESCE(max(number),0)+1 FROM task_flow_stage WHERE project_id='${input.projectId}'),
          'claim-proof','default','${key}','${session}','${ids.workflowVersion}','${ids.catalogueVersion}',
          '{}',0,'work','running','[]',1,'${ids.machine}','${ids.machine}',1,now(),now());
       UPDATE task_flow SET open_stage_record_id='${ids.stage}' WHERE id='${ids.flow}';`,
    )
    return ids.stage
  }

  test('task claim take requires the caller owned stage and follows a stage handoff', async () => {
    const take = (token: string, body: Record<string, unknown>) =>
      fetch(`${input.origin()}/v1/board/claims`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify(body),
      })
    const key = 'BAPI-CURSOR'
    const sessionA = 'cursor-session-a'
    const sessionB = 'cursor-session-b'
    const refused = await take(input.tokenA(), {
      id: newRecordId(),
      project: input.project,
      projectId: input.projectId,
      subject: `task:${key}`,
      holderSession: sessionA,
    })
    expect(refused.status).toBe(400)

    const stageId = seedOwnedTaskStage(key, sessionA)
    const firstId = newRecordId()
    const first = await take(input.tokenA(), {
      id: firstId,
      project: input.project,
      projectId: input.projectId,
      subject: `task:${key}`,
      holderSession: sessionA,
    })
    expect(first.status).toBe(200)
    expect((await json(first)).action).toBe('taken')

    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE task_flow_stage SET session_id='${sessionB}' WHERE id='${stageId}';`,
    )
    const second = await take(input.tokenB(), {
      id: newRecordId(),
      project: input.project,
      projectId: input.projectId,
      subject: `task:${key}`,
      holderSession: sessionB,
    })
    expect(second.status).toBe(200)
    expect((await json(second)).action).toBe('taken-over')

    const listed = await json(
      await fetch(
        `${input.origin()}/v1/board/claims?project=${input.project}&projectId=${input.projectId}`,
        { headers: headers(input.tokenA()) },
      ),
    )
    expect(
      (listed.claims as Array<{ id: string; closeReason: string | null }>).find(
        (claim) => claim.id === firstId,
      )?.closeReason,
    ).toBe('taken-over')
  })

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
    const sameSessionTake = await take(input.tokenA(), {
      id: newRecordId(),
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:gpu',
      holderSession: 'holder-a',
      durationMs: 60_000,
    })
    expect(sameSessionTake.status).toBe(200)
    expect(await json(sameSessionTake)).toMatchObject({ id: liveId, action: 'renewed' })
    const sameUserConflict = await take(input.tokenA(), {
      id: newRecordId(),
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:gpu',
      holderSession: 'holder-b',
    })
    expect(sameUserConflict.status).toBe(409)
    const sameUserConflictBody = JSON.stringify(await sameUserConflict.json())
    expect(sameUserConflictBody).toContain(input.userA())
    expect(sameUserConflictBody).toContain('session holder-a')
    expect(sameUserConflictBody).toContain('board ask --audience session:holder-a')
    const foreignRenew = await fetch(`${input.origin()}/v1/board/claims/${liveId}/renew`, {
      method: 'POST',
      headers: headers(input.tokenA()),
      body: JSON.stringify({ holderSession: 'holder-b' }),
    })
    expect(foreignRenew.status).toBe(403)
    const foreignRelease = await fetch(`${input.origin()}/v1/board/claims/${liveId}/release`, {
      method: 'POST',
      headers: headers(input.tokenA()),
      body: JSON.stringify({ holderSession: 'holder-b' }),
    })
    expect(foreignRelease.status).toBe(403)
    expect(JSON.stringify(await foreignRelease.json())).toContain('session:holder-a')
    const foreignUserSameSession = await fetch(
      `${input.origin()}/v1/board/claims/${liveId}/renew`,
      {
        method: 'POST',
        headers: headers(input.tokenB()),
        body: JSON.stringify({ holderSession: 'holder-a' }),
      },
    )
    expect(foreignUserSameSession.status).toBe(403)
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
      notices.items as Array<{
        message: { audience: string; claimId: string | null; body: string }
      }>
    ).some(
      (item) =>
        item.message.audience === 'session:holder-a' &&
        item.message.claimId === liveId &&
        item.message.body.includes('Session holder-b attempted to claim'),
    )
    expect(told).toBeTrue()
    const lapsedId = newRecordId()
    const short = await take(input.tokenA(), {
      id: lapsedId,
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:bapi-1',
      holderSession: 'holder-a',
      durationMs: 1,
    })
    expect(short.status).toBe(200)
    await Bun.sleep(20)
    const successor = newRecordId()
    const takeover = await take(input.tokenA(), {
      id: successor,
      project: input.project,
      projectId: input.projectId,
      subject: 'resource:bapi-1',
      holderSession: 'holder-b',
    })
    expect(takeover.status).toBe(200)
    expect((await json(takeover)).action).toBe('taken-over')
    const takeoverNotices = await json(
      await fetch(`${input.origin()}/v1/board/changes?after=0&limit=100`, {
        headers: headers(input.tokenA()),
      }),
    )
    expect(
      (
        takeoverNotices.items as Array<{
          message: { audience: string; claimId: string | null; body: string }
        }>
      ).some(
        (item) =>
          item.message.audience === 'session:holder-a' &&
          item.message.claimId === lapsedId &&
          item.message.body.includes('Session holder-b took over'),
      ),
    ).toBeTrue()
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
          subject: 'resource:bapi-2',
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
      subject: 'resource:bapi-2',
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
         IF NEW.subject_kind='resource' AND NEW.subject_value='bapi-3'
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
        subject: 'resource:bapi-3',
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
    seedOwnedTaskStage('BAPI-9', 'holder-a')
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
