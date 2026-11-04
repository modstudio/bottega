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
