import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import {
  selectRecordProjectLensProfile,
  upsertRecordLens,
  upsertRecordLensProfile,
} from './record-lens-catalogue.ts'
import { RecordLensError } from './record-lens-contract.ts'

const url = process.env.ORCH_TEST_LENS_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const projectId = newRecordId()
const userId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted lens catalogue compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Lens CAS ${spaceId}`},${`lens-${spaceId}`},now())`
      await sql`INSERT INTO project (id,space_id,name) VALUES (${projectId}::uuid,${spaceId}::uuid,'lens-cas-project')`
    } finally {
      await sql.close()
    }
  })

  test('lens, profile and selection refuse stale updates without changing live or revision state', async () => {
    const lensInput = {
      ...tenant(),
      key: 'cas-lens',
      title: 'Create',
      question: 'Question?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'create',
    }
    await upsertRecordLens(lensInput)
    await upsertRecordLens({ ...lensInput, title: 'Update', expectedVersion: 1, reason: 'update' })
    await expect(
      upsertRecordLens({ ...lensInput, title: 'Stale', expectedVersion: 1, reason: 'stale' }),
    ).rejects.toMatchObject({ status: 409 })

    const profileInput = {
      ...tenant(),
      lensKey: 'cas-lens',
      axis: 'framework' as const,
      name: 'default',
      body: '{}',
      enabled: true,
      expectedVersion: null,
      reason: 'create',
    }
    await upsertRecordLensProfile(profileInput)
    await upsertRecordLensProfile({
      ...profileInput,
      body: '{"updated":"yes"}',
      expectedVersion: 1,
      reason: 'update',
    })
    await expect(
      upsertRecordLensProfile({
        ...profileInput,
        body: '{"stale":"yes"}',
        expectedVersion: 1,
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ status: 409 })

    const selectionInput = {
      ...tenant(),
      projectId,
      lensKey: 'cas-lens',
      axis: 'framework' as const,
      profileName: 'default',
      selectedVersion: 1,
      expectedSelectionVersion: null,
      reason: 'create',
    }
    await selectRecordProjectLensProfile(selectionInput)
    await selectRecordProjectLensProfile({
      ...selectionInput,
      selectedVersion: 2,
      expectedSelectionVersion: 1,
      reason: 'update',
    })
    await expect(
      selectRecordProjectLensProfile({
        ...selectionInput,
        expectedSelectionVersion: 1,
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ status: 409 })

    const sql = new SQL(url!)
    try {
      const [lens] =
        await sql`SELECT title,version FROM lens WHERE space_id=${spaceId}::uuid AND key='cas-lens'`
      const [profile] =
        await sql`SELECT body,version FROM lens_profile WHERE space_id=${spaceId}::uuid AND name='default'`
      const [selection] =
        await sql`SELECT selected_version,selection_version FROM project_lens_profile WHERE space_id=${spaceId}::uuid AND project_id=${projectId}::uuid`
      const [counts] = await sql`SELECT
        (SELECT count(*)::integer FROM lens_revision WHERE space_id=${spaceId}::uuid) lens_revisions,
        (SELECT count(*)::integer FROM lens_profile_revision WHERE space_id=${spaceId}::uuid) profile_revisions,
        (SELECT count(*)::integer FROM project_lens_profile_revision WHERE space_id=${spaceId}::uuid) selection_revisions`
      expect(lens).toMatchObject({ title: 'Update', version: 2 })
      expect(profile).toMatchObject({ body: '{"updated":"yes"}', version: 2 })
      expect(selection).toMatchObject({ selected_version: 2, selection_version: 2 })
      expect(counts).toEqual({ lens_revisions: 1, profile_revisions: 1, selection_revisions: 2 })
    } finally {
      await sql.close()
    }
  })

  test('two concurrent creates serialize to one success and one named stale refusal', async () => {
    const input = {
      ...tenant(),
      key: 'racing-create',
      title: 'Race',
      question: 'Who wins?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'race',
    }
    const settled = await Promise.allSettled([upsertRecordLens(input), upsertRecordLens(input)])
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.any(RecordLensError) })
    expect((rejected as PromiseRejectedResult).reason.status).toBe(409)
  })
})
