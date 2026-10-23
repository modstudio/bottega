import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import {
  getRecordDoc,
  listRecordDocRevisions,
  restoreRecordDoc,
  upsertRecordDoc,
} from '../record/record-docs.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = actorUrl && adminUrl ? describe : describe.skip

const SPACE_ID = '01990000-0000-7000-8000-000000001303'
const USER_ID = '01990000-0000-7000-8000-000000001304'
const PROJECT_ID = '01990000-0000-7000-8000-000000001305'
const OWN_SUBJECT_ID = '01990000-0000-7000-8000-000000001306'
const RELATED_SUBJECT_ID = '01990000-0000-7000-8000-000000001307'

realPostgres('Bun SQL jsonb binding', () => {
  test('stores a raw structured value as an array and a serialized value as a string', async () => {
    const sql = new SQL(adminUrl!)
    try {
      await sql`CREATE TEMP TABLE jsonb_binding_proof (name text PRIMARY KEY, value jsonb NOT NULL)`
      const value = ['src/article.ts']
      await sql`INSERT INTO jsonb_binding_proof VALUES ('raw', ${value}::jsonb)`
      await sql`INSERT INTO jsonb_binding_proof VALUES ('serialized', ${JSON.stringify(value)}::jsonb)`
      await sql`INSERT INTO jsonb_binding_proof VALUES ('helper', ${bindJsonb(sql, value)})`
      const rows =
        await sql`SELECT name,jsonb_typeof(value) AS type FROM jsonb_binding_proof ORDER BY name`
      expect([...rows]).toEqual([
        { name: 'helper', type: 'array' },
        { name: 'raw', type: 'array' },
        { name: 'serialized', type: 'string' },
      ])
    } finally {
      await sql.close()
    }
  })

  test('the document service stores and reads article lists as arrays', async () => {
    const admin = new SQL(adminUrl!)
    const checkedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const writtenSummary = 'Written hosted summary.'
    try {
      await admin`
        INSERT INTO space (id,name,slug,created_at)
        VALUES (${SPACE_ID}::uuid,'jsonb proof','jsonb-proof',now())
      `
      await admin`
        INSERT INTO "user" (id,email,name,created_at)
        VALUES (${USER_ID}::uuid,'jsonb-proof@example.test','JSONB Proof',now())
      `
      await admin`
        INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES ('01990000-0000-7000-8000-000000001308'::uuid,${SPACE_ID}::uuid,${USER_ID}::uuid,'member','write',now())
      `
      await admin`
        INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES (${PROJECT_ID}::uuid,${SPACE_ID}::uuid,'jsonb-proof',ARRAY['JBP'],now())
      `
      await admin`
        INSERT INTO subject (id,space_id,project_id,name,definition,position,created_at,updated_at)
        VALUES
          (${OWN_SUBJECT_ID}::uuid,${SPACE_ID}::uuid,${PROJECT_ID}::uuid,'Own','Own subject.',0,now(),now()),
          (${RELATED_SUBJECT_ID}::uuid,${SPACE_ID}::uuid,${PROJECT_ID}::uuid,'Related','Related subject.',1,now(),now())
      `
      const written = await upsertRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        scope: 'project',
        subject: 'jsonb-proof',
        projectId: PROJECT_ID,
        slug: 'binding-proof',
        title: 'Binding proof',
        body: 'The stored lists remain arrays.',
        delivery: 'demand',
        audiences: ['technical'],
        kind: 'article',
        form: 'feature',
        articleSubjectId: OWN_SUBJECT_ID,
        relatedSubjectIds: [RELATED_SUBJECT_ID],
        sourceFiles: ['src/article.ts'],
        checkedAgainstCommit: checkedCommit,
        summary: writtenSummary,
        reason: 'prove JSONB binding',
        author: USER_ID,
      })
      const storedTypes = await admin`
          SELECT jsonb_typeof(d.source_files) AS doc_source_files,
            jsonb_typeof(r.source_files) AS revision_source_files,
            jsonb_typeof(r.related_subject_ids) AS revision_related_subject_ids
          FROM doc d JOIN doc_revision r ON r.id=d.latest_revision_id
          WHERE d.id=${written.id}::uuid
        `
      expect([...storedTypes]).toEqual([
        {
          doc_source_files: 'array',
          revision_source_files: 'array',
          revision_related_subject_ids: 'array',
        },
      ])
      const read = await getRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
      })
      expect(read?.sourceFiles).toEqual(['src/article.ts'])
      expect(read?.relatedSubjects).toEqual([{ id: RELATED_SUBJECT_ID, name: 'Related' }])
      expect(read?.checkedAgainstCommit).toBe(checkedCommit)
      expect(read).toMatchObject({ summary: writtenSummary, summarySource: 'written' })
      const revisions = await listRecordDocRevisions({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
      })
      expect(revisions?.[0]?.relatedSubjects).toEqual([{ id: RELATED_SUBJECT_ID, name: 'Related' }])

      const kept = await upsertRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        scope: 'project',
        subject: 'jsonb-proof',
        projectId: PROJECT_ID,
        slug: 'binding-proof',
        title: 'Binding proof',
        body: 'The stored lists and checked commit remain unchanged when omitted.',
        delivery: 'demand',
        reason: 'prove omitted checked commit is kept',
        author: USER_ID,
        expectedRevision: written.revisionId,
      })
      const readKept = await getRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
      })
      expect(readKept?.checkedAgainstCommit).toBe(checkedCommit)
      expect(readKept).toMatchObject({ summary: writtenSummary, summarySource: 'written' })
      const keptRevisions = await admin`
        SELECT id, checked_against_commit
        FROM doc_revision
        WHERE id IN (${written.revisionId}::uuid, ${kept.revisionId}::uuid)
        ORDER BY id
      `
      expect([...keptRevisions]).toEqual(
        [
          { id: written.revisionId, checked_against_commit: checkedCommit },
          { id: kept.revisionId, checked_against_commit: checkedCommit },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      )

      const cleared = await upsertRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        scope: 'project',
        subject: 'jsonb-proof',
        projectId: PROJECT_ID,
        slug: 'binding-proof',
        title: 'Binding proof',
        body: 'The checked commit is explicitly cleared.',
        delivery: 'demand',
        checkedAgainstCommit: null,
        summary: null,
        reason: 'prove checked commit can be cleared',
        author: USER_ID,
        expectedRevision: kept.revisionId,
      })
      const readCleared = await getRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
      })
      expect(readCleared?.checkedAgainstCommit).toBeNull()
      expect(readCleared).toMatchObject({
        summary: 'The checked commit is explicitly cleared.',
        summarySource: 'derived',
      })
      const clearedRevisions = await admin`
        SELECT id, checked_against_commit, summary
        FROM doc_revision
        WHERE id IN (
          ${written.revisionId}::uuid,
          ${kept.revisionId}::uuid,
          ${cleared.revisionId}::uuid
        )
        ORDER BY id
      `
      expect([...clearedRevisions]).toEqual(
        [
          {
            id: written.revisionId,
            checked_against_commit: checkedCommit,
            summary: writtenSummary,
          },
          { id: kept.revisionId, checked_against_commit: checkedCommit, summary: writtenSummary },
          { id: cleared.revisionId, checked_against_commit: null, summary: null },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      )

      await restoreRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
        revisionId: written.revisionId,
        reason: 'restore written summary revision',
        author: USER_ID,
        expectedRevision: cleared.revisionId,
      })
      const restored = await getRecordDoc({
        url: actorUrl!,
        spaceId: SPACE_ID,
        userId: USER_ID,
        id: written.id,
      })
      expect(restored).toMatchObject({ summary: writtenSummary, summarySource: 'written' })
    } finally {
      await admin`UPDATE doc SET latest_revision_id=NULL WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM doc_revision WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM doc WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM subject WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM seq WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM project WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM membership WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id=${USER_ID}::uuid`
      await admin`DELETE FROM space WHERE id=${SPACE_ID}::uuid`
      await admin.close()
    }
  })
})
