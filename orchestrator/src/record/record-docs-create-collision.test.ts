import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { getRecordDoc, RecordDocError, upsertRecordDoc } from './record-docs.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const hosted = actorUrl && adminUrl ? describe : describe.skip

hosted('hosted document create collision', () => {
  const spaceId = '01990000-0000-7000-8000-000000002210'
  const userId = '01990000-0000-7000-8000-000000002211'
  const membershipId = '01990000-0000-7000-8000-000000002212'
  const tenant = { url: actorUrl!, spaceId, userId }

  test('refuses create without changing the row, then accepts set at the current revision', async () => {
    const admin = new SQL(adminUrl!)
    const originalBody = 'The original hosted body remains after a create collision.'
    const replacementBody = 'A set with the observed revision replaces the hosted body.'
    try {
      await admin`
        INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,'doc create collision','doc-create-collision',now())
      `
      await admin`
        INSERT INTO "user" (id,email,name,created_at)
        VALUES (${userId}::uuid,'doc-create-collision@example.test','Doc Create Collision',now())
      `
      await admin`
        INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${membershipId}::uuid,${spaceId}::uuid,${userId}::uuid,'member','write',now())
      `
      const created = await upsertRecordDoc({
        ...tenant,
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'create-collision',
        title: 'Create collision',
        body: originalBody,
        delivery: 'demand',
        reason: 'create hosted collision fixture',
        author: userId,
        op: 'create',
      })

      let refusal: unknown
      try {
        await upsertRecordDoc({
          ...tenant,
          scope: 'project',
          subject: PLATFORM_SLUG,
          slug: 'create-collision',
          title: 'Create collision',
          body: 'A colliding create must not be stored.',
          delivery: 'demand',
          reason: 'prove create collision refusal',
          author: userId,
          op: 'create',
        })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(RecordDocError)
      expect((refusal as RecordDocError).status).toBe(409)
      expect((refusal as Error).message).toBe(
        `refusing create for project/${PLATFORM_SLUG}/create-collision: the row already exists at revision ${created.revisionId}\n` +
          `cleared by: read the doc, then write it with ${PLATFORM_SLUG} doc set create-collision --scope project --subject ${PLATFORM_SLUG} --expect ${created.revisionId}`,
      )
      expect((await getRecordDoc({ ...tenant, id: created.id }))?.body).toBe(originalBody)

      const written = await upsertRecordDoc({
        ...tenant,
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'create-collision',
        title: 'Create collision',
        body: replacementBody,
        delivery: 'demand',
        reason: 'replace through observed revision',
        author: userId,
        op: 'set',
        expectedRevision: created.revisionId,
      })
      expect(written.revisionId).not.toBe(created.revisionId)
      expect((await getRecordDoc({ ...tenant, id: created.id }))?.body).toBe(replacementBody)
    } finally {
      await admin`UPDATE doc SET latest_revision_id=NULL WHERE space_id=${spaceId}::uuid`
      await admin`DELETE FROM doc_revision WHERE space_id=${spaceId}::uuid`
      await admin`DELETE FROM doc WHERE space_id=${spaceId}::uuid`
      await admin`DELETE FROM membership WHERE space_id=${spaceId}::uuid`
      await admin`DELETE FROM "user" WHERE id=${userId}::uuid`
      await admin`DELETE FROM space WHERE id=${spaceId}::uuid`
      await admin.close()
    }
  })
})
