import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { OUTSIDE_WRITES_PER_HOUR } from '../../shared/outside-write-decision.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
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
  nonOwnerUserId: () => string
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
  actorUrl: string
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

  test('an owner hides and unhides an outside board message', async () => {
    const messageId = newRecordId()
    const restoreUser = makeOutsideAuthorEligible()
    try {
      const authored = await input.post(input.token(), {
        ...notice(messageId, `project:${input.intakeProject}`, input.caseSession('outside-hide')),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(authored.status).toBe(200)
      const hidden = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId, reason: 'spam' }),
      })
      expect(hidden.status).toBe(200)
      const hiddenRow = (await json(hidden)).hidden as Record<string, unknown>
      expect(hiddenRow).toMatchObject({ id: messageId, reason: 'spam' })

      const read = (token: string) =>
        fetch(`${input.origin()}/v1/board/messages/${messageId}/status`, {
          headers: headers(token),
        })
      expect((await read(input.nonOwnerToken())).status).toBe(404)
      const authorRead = await read(input.token())
      expect(authorRead.status).toBe(200)
      expect((await json(authorRead)).message).toMatchObject({
        id: messageId,
        hiddenReason: 'spam',
        hiddenAt: hiddenRow.hiddenAt,
        hiddenByUserId: hiddenRow.hiddenByUserId,
      })
      expect((await read(input.ownerToken())).status).toBe(200)
      const listed = await fetch(`${input.origin()}/v1/moderation/hidden`, {
        headers: headers(input.ownerToken()),
      })
      expect(listed.status).toBe(200)
      expect((await json(listed)).hidden).toContainEqual(hiddenRow)

      const unhidden = await fetch(`${input.origin()}/v1/moderation/unhide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId }),
      })
      expect(unhidden.status).toBe(200)
      expect((await read(input.nonOwnerToken())).status).toBe(200)
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_outside_write WHERE subject_id='${messageId}';
         DELETE FROM board_message WHERE id='${messageId}';`,
      )
      restoreUser()
    }
  })

  test('moderation hide refuses non-owners, unknown reasons, and missing notes', async () => {
    const messageId = newRecordId()
    const missingNumber = 9_999_999
    const restoreUser = makeOutsideAuthorEligible()
    try {
      const authored = await input.post(input.token(), {
        ...notice(
          messageId,
          `project:${input.intakeProject}`,
          input.caseSession('outside-hide-refusal'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(authored.status).toBe(200)
      const nonOwner = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.nonOwnerToken()),
        body: JSON.stringify({ message: messageId, reason: 'spam' }),
      })
      expect(nonOwner.status).toBe(403)
      expect(JSON.stringify(await nonOwner.json())).toContain(
        'hiding a row requires the active space owner',
      )
      const invalid = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId, reason: 'rude' }),
      })
      expect(invalid.status).toBe(400)
      expect(JSON.stringify(await invalid.json())).toContain(
        'spam, abuse, off-topic, personal-data, duplicate',
      )
      const missing = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ note: `${input.intakeProject}#${missingNumber}`, reason: 'spam' }),
      })
      expect(missing.status).toBe(404)
      expect(JSON.stringify(await missing.json())).toContain(
        `no note ${input.intakeProject}#${missingNumber} in the active space`,
      )
    } finally {
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM space_outside_write WHERE subject_id='${messageId}';
         DELETE FROM board_message WHERE id='${messageId}';`,
      )
      restoreUser()
    }
  })

  test('owner moderation protects hidden columns and refuses shared-space notices', async () => {
    const messageId = newRecordId()
    const sharedMessageId = newRecordId()
    const noteId = newRecordId()
    const noteNumber = 9_999_998
    const actor = new SQL(input.actorUrl)
    try {
      const memberMessage = await input.post(input.nonOwnerToken(), {
        ...notice(
          messageId,
          `project:${input.intakeProject}`,
          input.caseSession('member-hidden-guard'),
        ),
        project: input.intakeProject,
        projectId: input.intakeProjectId,
      })
      expect(memberMessage.status).toBe(200)
      const hiddenMessage = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId, reason: 'abuse' }),
      })
      expect(hiddenMessage.status).toBe(200)
      await expect(
        actor.begin(async (tx) => {
          await bindTenant(tx, {
            userId: input.nonOwnerUserId(),
            spaceId: input.spaceId(),
            spaceIds: [input.spaceId()],
          })
          await tx`UPDATE board_message SET hidden_at=NULL,hidden_by_user_id=NULL,
            hidden_reason=NULL WHERE id=${messageId}::uuid`
        }),
      ).rejects.toThrow('hidden fields may only be changed through owner moderation')
      const unhiddenMessage = await fetch(`${input.origin()}/v1/moderation/unhide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: messageId }),
      })
      expect(unhiddenMessage.status).toBe(200)

      input.succeeds(
        'postgres',
        'postgres',
        `INSERT INTO hub_note
          (id,space_id,project_name,project_id,author_user_id,number,project,text,anchors,
           sightings,created_at,last_seen_at,updated_at)
         VALUES ('${noteId}','${input.spaceId()}','${input.intakeProject}',
          '${input.intakeProjectId}','${input.nonOwnerUserId()}',${noteNumber},
          '${input.intakeProject}','moderation note','[]',1,now(),now(),now());`,
      )
      const hiddenNote = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ note: `${input.intakeProject}#${noteNumber}`, reason: 'spam' }),
      })
      expect(hiddenNote.status).toBe(200)
      const unhiddenNote = await fetch(`${input.origin()}/v1/moderation/unhide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ note: `${input.intakeProject}#${noteNumber}` }),
      })
      expect(unhiddenNote.status).toBe(200)

      const shared = await input.post(input.ownerToken(), {
        ...notice(sharedMessageId, 'spaces', input.caseSession('shared-space-hide-refusal')),
      })
      expect(shared.status).toBe(200)
      const sharedHide = await fetch(`${input.origin()}/v1/moderation/hide`, {
        method: 'POST',
        headers: headers(input.ownerToken()),
        body: JSON.stringify({ message: sharedMessageId, reason: 'spam' }),
      })
      expect(sharedHide.status).toBe(400)
      expect(JSON.stringify(await sharedHide.json())).toContain(
        'a notice that reaches shared spaces cannot be hidden',
      )
    } finally {
      await actor.close()
      input.succeeds(
        'postgres',
        'postgres',
        `DELETE FROM hub_note WHERE id='${noteId}';
         DELETE FROM board_message WHERE id IN ('${messageId}','${sharedMessageId}');`,
      )
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
