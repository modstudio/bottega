import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { identity } from './record-api-identity.fixture.ts'
import { setOutsideIntake } from './record-outside-intake.ts'

const actorUrl = process.env.BOTTEGA_TEST_CATALOGUE_IMPORT_URL
const setupUrl = process.env.BOTTEGA_TEST_CATALOGUE_IMPORT_SETUP_URL
const postgres = actorUrl && setupUrl ? describe : describe.skip

postgres('outside-intake requested space', () => {
  test('the mounted header writes the named space while another space is active', async () => {
    const userId = newRecordId()
    const activeSpaceId = newRecordId()
    const namedSpaceId = newRecordId()
    const projectId = newRecordId()
    const namedSlug = `intake-${namedSpaceId}`
    const project = `intake-project-${projectId}`
    const setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Outside Intake',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at) VALUES
        (${activeSpaceId}::uuid,'Active Intake',${`active-${activeSpaceId}`},now()),
        (${namedSpaceId}::uuid,'Named Intake',${namedSlug},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
        (${newRecordId()}::uuid,${activeSpaceId}::uuid,${userId}::uuid,'owner','write',now()),
        (${newRecordId()}::uuid,${namedSpaceId}::uuid,${userId}::uuid,'owner','write',now())`
      await setup`INSERT INTO project (id,space_id,name,created_at)
        VALUES (${projectId}::uuid,${namedSpaceId}::uuid,${project},now())`

      const app = recordApiTestApp(
        {
          ...identity,
          user: { id: userId, email: `${userId}@test.invalid` },
          activeSpaceId,
          personalSpaceId: activeSpaceId,
          memberships: [
            {
              space_id: activeSpaceId,
              name: 'Active Intake',
              slug: `active-${activeSpaceId}`,
              role: 'owner',
              permission: 'write',
            },
            {
              space_id: namedSpaceId,
              name: 'Named Intake',
              slug: namedSlug,
              role: 'owner',
              permission: 'write',
            },
          ],
        },
        { ...idleSubjectDeps(), ...idleRecordApiDeps() },
        { recordUrl: actorUrl, setOutsideIntake },
      )
      const response = await app.request('/v1/outside-intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-record-space': namedSlug },
        body: JSON.stringify({ project }),
      })
      expect(response.status).toBe(200)
      expect(
        await setup`SELECT space_id::text,project_id::text FROM space_outside_intake
          WHERE space_id=${namedSpaceId}::uuid`,
      ).toEqual([{ space_id: namedSpaceId, project_id: projectId }])
      expect(
        await setup`SELECT count(*)::int count FROM space_outside_intake
          WHERE space_id=${activeSpaceId}::uuid`,
      ).toEqual([{ count: 0 }])
    } finally {
      await setup`DELETE FROM space_outside_intake WHERE space_id IN (${activeSpaceId}::uuid,${namedSpaceId}::uuid)`
      await setup`DELETE FROM project WHERE id=${projectId}::uuid`
      await setup`DELETE FROM membership WHERE user_id=${userId}::uuid`
      await setup`DELETE FROM space WHERE id IN (${activeSpaceId}::uuid,${namedSpaceId}::uuid)`
      await setup`DELETE FROM "user" WHERE id=${userId}::uuid`
      await setup.close()
    }
  })
})
