import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import type { RecordIdentity } from './record-auth.ts'
import { hostedProjectColumns } from './record-project-columns.ts'
import { mapRecordProjectRow, upsertHostedProjectRow } from './record-projects.ts'

const spaceId = '01990000-0000-7000-8000-000000002200'
const userId = '01990000-0000-7000-8000-000000002201'
const projectId = '01990000-0000-7000-8000-000000002202'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})

afterAll(async () => {
  if (database) await database.close()
})

function recordApp() {
  const sql = pgliteSql(database)
  const identity: RecordIdentity = {
    user: { id: userId, email: 'project-revision@example.test' },
    activeSpaceId: spaceId,
    personalSpaceId: spaceId,
    memberships: [
      {
        space_id: spaceId,
        name: 'Project revision',
        slug: 'project-revision',
        role: 'owner',
        permission: 'write',
      },
    ],
  }
  return recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      readProjects: async () => {
        const rows = await database.query<Record<string, unknown>>(
          'SELECT p.*,s.name AS space_name FROM project p JOIN space s ON s.id=p.space_id',
        )
        return rows.rows.map(mapRecordProjectRow)
      },
      upsertProject: async (input) => {
        const written = await upsertHostedProjectRow(sql, {
          ...input,
          columns: hostedProjectColumns(input.settings, input.name),
        })
        return { ...written, name: input.name }
      },
    },
  )
}

function projectBody(name: string, expectedRevision?: number): string {
  return JSON.stringify({
    id: projectId,
    name,
    path: '/w/project-revision',
    stack: null,
    canon: false,
    settings: {},
    retiredAt: null,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  })
}

function putProject(
  application: ReturnType<typeof recordApp>,
  name: string,
  expectedRevision?: number,
) {
  return application.request('/v1/projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': spaceId },
    body: projectBody(name, expectedRevision),
  })
}

test('the real record app refuses a stale project revision and names the pull remedy', async () => {
  const application = recordApp()
  expect(await (await putProject(application, 'project-revision')).json()).toEqual({
    id: projectId,
    name: 'project-revision',
    revision: 1,
  })
  const read = (await (await application.request('/v1/projects')).json()) as Array<{
    revision: number
  }>
  expect(read[0]?.revision).toBe(1)

  expect(
    await (await putProject(application, 'newer-project', read[0]!.revision)).json(),
  ).toMatchObject({ revision: 2 })
  const stale = await putProject(application, 'stale-project', read[0]!.revision)
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({
    error:
      `project ${projectId} changed since revision 1; now 2.\n` +
      `cleared by: ${PLATFORM_SLUG} record pull`,
  })
  expect(
    (await database.query<{ name: string }>('SELECT name FROM project WHERE id=$1', [projectId]))
      .rows,
  ).toEqual([{ name: 'newer-project' }])
})
