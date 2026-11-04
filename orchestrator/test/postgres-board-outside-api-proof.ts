import { expect, test } from 'bun:test'
import { OUTSIDE_WRITES_PER_HOUR } from '../../shared/outside-write-decision.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { headers, json, notice } from './postgres-board-api-values.ts'

const SEEDED_SUBJECTS = [
  '03990000-0000-7000-8000-000000000031',
  '03990000-0000-7000-8000-000000000032',
  '03990000-0000-7000-8000-000000000033',
] as const

export function registerBoardOutsideApiProof(input: {
  origin: () => string
  token: () => string
  ownerToken: () => string
  nonOwnerToken: () => string
  readMemberToken: () => string
  memberToken: () => string
  userId: () => string
  spaceId: () => string
  intakeProject: string
  intakeProjectId: string
  otherProject: string
  post: (token: string, body: Record<string, unknown>) => Promise<Response>
  caseSession: (label: string) => string
  succeeds: (user: string, password: string, source: string) => string
}): void {
  const makeOutsideAuthorEligible = () => {
    const userId = input.userId()
    const previous = input
      .succeeds(
        'postgres',
        'postgres',
        `SELECT extract(epoch FROM created_at),email_verified FROM "user" WHERE id='${userId}';`,
      )
      .split('|')
    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE "user" SET created_at=now() - interval '2 days',email_verified=true
       WHERE id='${userId}';`,
    )
    return () =>
      input.succeeds(
        'postgres',
        'postgres',
        `UPDATE "user" SET created_at='${new Date(Number(previous[0]) * 1_000).toISOString()}'::timestamptz,
           email_verified=${previous[1] === 't'} WHERE id='${userId}';`,
      )
  }

  test('an outside author posts and replies through the intake route until the hourly limit', async () => {
    expect(SEEDED_SUBJECTS).toHaveLength(OUTSIDE_WRITES_PER_HOUR - 2)
    const rootId = newRecordId()
    const replyId = newRecordId()
    const refusedId = newRecordId()
    const mismatchId = newRecordId()
    const replyMismatchId = newRecordId()
    const nameOnlyId = newRecordId()
    const userId = input.userId()
    const previousUser = input
      .succeeds(
        'postgres',
        'postgres',
        `SELECT extract(epoch FROM created_at),email_verified FROM "user" WHERE id='${userId}';`,
      )
      .split('|')
    const previousCreatedAt = new Date(Number(previousUser[0]) * 1_000).toISOString()
    const previousEmailVerified = previousUser[1] === 't'
    input.succeeds(
      'postgres',
      'postgres',
      `UPDATE "user" SET created_at=now() - interval '2 days',email_verified=true
       WHERE id='${userId}';`,
    )
    try {
      const nameOnly = await input.post(input.token(), {
        ...notice(
          nameOnlyId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-intake-name-only'),
        ),
        project: input.intakeProject,
        projectId: undefined,
      })
      expect(nameOnly.status).toBe(200)
      expect((await json(nameOnly)).id).toBe(nameOnlyId)
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_outside_write WHERE subject_id='${nameOnlyId}';
         DELETE FROM board_message WHERE id='${nameOnlyId}';`,
      )

      const mismatch = await input.post(input.token(), {
        ...notice(
          mismatchId,
          `project:${input.otherProject}`,
          input.caseSession('outside-intake-mismatch'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(mismatch.status).toBe(400)
      expect(JSON.stringify(await mismatch.json())).toContain(
        `board project ${input.intakeProject} does not match audience project:${input.otherProject}`,
      )

      const posted = await input.post(input.token(), {
        ...notice(
          rootId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-intake-post'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(posted.status).toBe(200)
      expect((await json(posted)).id).toBe(rootId)
      expect(
        input.succeeds(
          'postgres',
          'postgres',
          `SELECT count(*) FROM space_outside_write
           WHERE user_id='${userId}' AND kind='post' AND subject_id='${rootId}';`,
        ),
      ).toBe('1')

      const replied = await fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
        method: 'POST',
        headers: headers(input.token()),
        body: JSON.stringify({
          id: replyId,
          body: 'Outside author reply.',
          authorSession: input.caseSession('outside-intake-reply'),
        }),
      })
      expect(replied.status).toBe(200)
      expect((await json(replied)).id).toBe(replyId)

      const replyMismatch = await fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
        method: 'POST',
        headers: headers(input.token()),
        body: JSON.stringify({
          id: replyMismatchId,
          body: 'Outside author reply with the wrong project.',
          authorSession: input.caseSession('outside-intake-reply-mismatch'),
          project: input.otherProject,
        }),
      })
      expect(replyMismatch.status).toBe(400)
      expect(JSON.stringify(await replyMismatch.json())).toContain(
        `board project ${input.otherProject} does not match audience project:${input.intakeProject}`,
      )

      input.succeeds(
        'postgres',
        'postgres',
        `INSERT INTO space_outside_write (id,space_id,user_id,kind,subject_id,created_at) VALUES
          ('${newRecordId()}','${input.spaceId()}','${userId}','post','${SEEDED_SUBJECTS[0]}',now()),
          ('${newRecordId()}','${input.spaceId()}','${userId}','post','${SEEDED_SUBJECTS[1]}',now()),
          ('${newRecordId()}','${input.spaceId()}','${userId}','post','${SEEDED_SUBJECTS[2]}',now());`,
      )
      const refused = await input.post(input.token(), {
        ...notice(
          refusedId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-intake-rate'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(refused.status).toBe(429)
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_outside_write WHERE user_id='${userId}' AND subject_id IN
          ('${nameOnlyId}','${rootId}','${replyId}','${SEEDED_SUBJECTS[0]}','${SEEDED_SUBJECTS[1]}','${SEEDED_SUBJECTS[2]}');
         DELETE FROM board_message WHERE id IN ('${nameOnlyId}','${replyId}','${rootId}');
         UPDATE "user" SET created_at='${previousCreatedAt}'::timestamptz,
           email_verified=${previousEmailVerified} WHERE id='${userId}';`,
      )
    }
  })

  test('a read member cannot use the outside board path', async () => {
    const response = await input.post(input.readMemberToken(), {
      ...notice(
        newRecordId(),
        `project:${input.intakeProject}`,
        input.caseSession('outside-intake-read-member'),
      ),
      project: input.intakeProject,
      projectId: input.intakeProjectId,
    })
    expect(response.status).toBe(403)
    const body = JSON.stringify(await response.json())
    expect(body).toContain('membership is read-only')
    expect(body).toContain('space owner or admin')
  })

  test('an owner pauses and resumes outside writes through the intake routes', async () => {
    const refusedId = newRecordId()
    const acceptedId = newRecordId()
    const restoreUser = makeOutsideAuthorEligible()
    try {
      const paused = await fetch(`${input.origin()}/v1/outside-intake/pause`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ hours: 1 }),
      })
      expect(paused.status).toBe(200)
      const intake = (await json(paused)).intake as { pausedUntil: string }
      expect(new Date(intake.pausedUntil).getTime()).toBeGreaterThan(Date.now())

      const refused = await input.post(input.token(), {
        ...notice(refusedId, `project:${input.intakeProject}`, input.caseSession('outside-paused')),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toContain(
        'this space is not accepting outside posts right now',
      )

      const resumed = await fetch(`${input.origin()}/v1/outside-intake/resume`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: '{}',
      })
      expect(resumed.status).toBe(200)
      const accepted = await input.post(input.token(), {
        ...notice(
          acceptedId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-resumed'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(accepted.status).toBe(200)
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `UPDATE space_outside_intake SET paused_until=NULL,paused_by_user_id=NULL
         WHERE space_id='${input.spaceId()}';
         DELETE FROM space_outside_write WHERE subject_id IN ('${refusedId}','${acceptedId}');
         DELETE FROM board_message WHERE id IN ('${refusedId}','${acceptedId}');`,
      )
      restoreUser()
    }
  })

  test('a non-owner member cannot pause outside writes', async () => {
    const switched = await fetch(`${input.origin()}/v1/active-space`, {
      method: 'PUT',
      headers: headers(input.nonOwnerToken()),
      body: JSON.stringify({ spaceId: input.spaceId() }),
    })
    expect(switched.status).toBe(200)
    const paused = await fetch(`${input.origin()}/v1/outside-intake/pause`, {
      method: 'POST',
      headers: headers(input.nonOwnerToken()),
      body: JSON.stringify({ hours: 1 }),
    })
    expect(paused.status).toBe(403)
    expect(JSON.stringify(await paused.json())).toContain(
      'pausing outside writes requires the active space owner',
    )
  })

  test('expired timed pauses and blocks allow outside writes', async () => {
    const afterPauseId = newRecordId()
    const afterBlockId = newRecordId()
    const blockId = newRecordId()
    const restoreUser = makeOutsideAuthorEligible()
    try {
      input.succeeds(
        'postgres',
        'postgres',
        `UPDATE space_outside_intake
         SET paused_until=now() - interval '1 hour',
             paused_by_user_id=(
               SELECT user_id FROM membership
               WHERE space_id='${input.spaceId()}' AND role='owner'
               ORDER BY created_at LIMIT 1
             )
         WHERE space_id='${input.spaceId()}';`,
      )
      const afterPause = await input.post(input.token(), {
        ...notice(
          afterPauseId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-expired-pause'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(afterPause.status).toBe(200)

      input.succeeds(
        'postgres',
        'postgres',
        `UPDATE space_outside_intake SET paused_until=NULL,paused_by_user_id=NULL
         WHERE space_id='${input.spaceId()}';
         INSERT INTO space_posting_block
           (id,space_id,user_id,blocked_until,blocked_by_user_id,created_at)
         VALUES
           ('${blockId}','${input.spaceId()}','${input.userId()}',now() - interval '1 hour',
            (SELECT user_id FROM membership
             WHERE space_id='${input.spaceId()}' AND role='owner'
             ORDER BY created_at LIMIT 1),now());`,
      )
      const afterBlock = await input.post(input.token(), {
        ...notice(
          afterBlockId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-expired-block'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(afterBlock.status).toBe(200)
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `UPDATE space_outside_intake SET paused_until=NULL,paused_by_user_id=NULL
         WHERE space_id='${input.spaceId()}';
         DELETE FROM space_posting_block
         WHERE space_id='${input.spaceId()}' AND user_id='${input.userId()}';
         DELETE FROM space_outside_write WHERE subject_id IN ('${afterPauseId}','${afterBlockId}');
         DELETE FROM board_message WHERE id IN ('${afterPauseId}','${afterBlockId}');`,
      )
      restoreUser()
    }
  })

  test('an owner blocks and unblocks an outside author by message id', async () => {
    const authorMessageId = newRecordId()
    const missingMessageId = newRecordId()
    const refusedId = newRecordId()
    const acceptedId = newRecordId()
    const restoreUser = makeOutsideAuthorEligible()
    try {
      const authored = await input.post(input.token(), {
        ...notice(
          authorMessageId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-block-author'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(authored.status).toBe(200)
      const missing = await fetch(`${input.origin()}/v1/outside-blocks`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: missingMessageId }),
      })
      expect(missing.status).toBe(404)
      expect(JSON.stringify(await missing.json())).toContain(
        `no board message ${missingMessageId} in the active space`,
      )
      const blocked = await fetch(`${input.origin()}/v1/outside-blocks`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: authorMessageId, hours: 2 }),
      })
      expect(blocked.status).toBe(200)
      const block = (await json(blocked)).block as { userId: string; blockedUntil: string }
      expect(block.userId).toBe(input.userId())
      expect(new Date(block.blockedUntil).getTime()).toBeGreaterThan(Date.now())

      const refused = await input.post(input.token(), {
        ...notice(
          refusedId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-blocked'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toContain(
        'this space is not accepting outside posts right now',
      )

      const listed = await fetch(`${input.origin()}/v1/outside-blocks`, {
        headers: headers(input.ownerToken()),
      })
      expect(listed.status).toBe(200)
      expect((await json(listed)).blocks).toContainEqual(block)

      const unblocked = await fetch(`${input.origin()}/v1/outside-blocks/${input.userId()}`, {
        method: 'DELETE',
        headers: headers(input.ownerToken()),
      })
      expect(unblocked.status).toBe(200)
      const accepted = await input.post(input.token(), {
        ...notice(
          acceptedId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-unblocked'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(accepted.status).toBe(200)
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_posting_block WHERE space_id='${input.spaceId()}' AND user_id='${input.userId()}';
         DELETE FROM space_outside_write WHERE subject_id IN ('${authorMessageId}','${refusedId}','${acceptedId}');
         DELETE FROM board_message WHERE id IN ('${authorMessageId}','${refusedId}','${acceptedId}');`,
      )
      restoreUser()
    }
  })

  test('an owner blocks an outside author by note label', async () => {
    const noteId = newRecordId()
    const refusedId = newRecordId()
    const noteNumber = Number(
      input
        .succeeds(
          'postgres',
          'postgres',
          `SELECT COALESCE(max(number),0)+1000 FROM hub_note
           WHERE space_id='${input.spaceId()}' AND project_name='${input.intakeProject}';`,
        )
        .trim(),
    )
    const restoreUser = makeOutsideAuthorEligible()
    try {
      input.succeeds(
        'postgres',
        'postgres',
        `INSERT INTO hub_note
           (id,space_id,project_name,project_id,author_user_id,number,project,text,anchors,
            sightings,created_at,last_seen_at,updated_at)
         VALUES
           ('${noteId}','${input.spaceId()}','${input.intakeProject}','${input.intakeProjectId}',
            '${input.userId()}',${noteNumber},'${input.intakeProject}','outside note block target',
            '[]',1,now(),now(),now());`,
      )
      const blocked = await fetch(`${input.origin()}/v1/outside-blocks`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ note: `${input.intakeProject}#${noteNumber}` }),
      })
      expect(blocked.status).toBe(200)
      expect((await json(blocked)).block).toMatchObject({
        userId: input.userId(),
        blockedUntil: null,
      })

      const refused = await input.post(input.token(), {
        ...notice(
          refusedId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-note-blocked'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toContain(
        'this space is not accepting outside posts right now',
      )

      const missing = await fetch(`${input.origin()}/v1/outside-blocks`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ note: `${input.intakeProject}#${noteNumber + 1}` }),
      })
      expect(missing.status).toBe(404)
      expect(JSON.stringify(await missing.json())).toContain(
        `no note ${input.intakeProject}#${noteNumber + 1} in the active space`,
      )
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_posting_block
           WHERE space_id='${input.spaceId()}' AND user_id='${input.userId()}';
         DELETE FROM space_outside_write WHERE subject_id IN ('${noteId}','${refusedId}');
         DELETE FROM board_message WHERE id='${refusedId}';
         DELETE FROM hub_note WHERE id='${noteId}';`,
      )
      restoreUser()
    }
  })

  test("an owner's member-authored message cannot identify a block target", async () => {
    const messageId = newRecordId()
    try {
      const authored = await input.post(input.ownerToken(), {
        ...notice(
          messageId,
          `project:${input.intakeProject}`,
          input.caseSession('member-block-target'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(authored.status).toBe(200)
      const blocked = await fetch(`${input.origin()}/v1/outside-blocks`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId }),
      })
      expect(blocked.status).toBe(409)
      expect(JSON.stringify(await blocked.json())).toContain(
        'is a member of this space; blocks apply only to outside authors',
      )
    } finally {
      input.succeeds('postgres', 'postgres', `DELETE FROM board_message WHERE id='${messageId}';`)
    }
  })

  test('a member replies from their project to an architects audience for another project', async () => {
    const rootId = newRecordId()
    const replyId = newRecordId()
    const posted = await input.post(input.memberToken(), {
      ...notice(
        rootId,
        `architects:${input.intakeProject}`,
        input.caseSession('architects-other-project-root'),
      ),
      project: undefined,
      projectId: input.intakeProjectId,
    })
    expect(posted.status).toBe(200)
    const replied = await fetch(`${input.origin()}/v1/board/messages/${rootId}/replies`, {
      method: 'POST',
      headers: headers(input.memberToken()),
      body: JSON.stringify({
        id: replyId,
        body: 'Member reply from the posting project.',
        authorSession: input.caseSession('architects-other-project-reply'),
        project: input.otherProject,
      }),
    })
    expect(replied.status).toBe(200)
    expect((await json(replied)).id).toBe(replyId)
  })
}
