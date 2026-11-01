import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { registerRecordLensRoutes } from './record-api-lens.ts'
import type { RecordIdentity } from './record-auth.ts'
import { importRecordLensCatalogue } from './record-catalogue-import.ts'
import {
  listRecordLensCatalogue,
  selectRecordProjectLensProfile,
  upsertRecordLens,
  upsertRecordLensProfile,
} from './record-lens-catalogue.ts'
import { RecordLensError } from './record-lens-contract.ts'

const url = process.env.BOTTEGA_TEST_LENS_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const pagingSpaceId = newRecordId()
const projectId = newRecordId()
const userId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted lens catalogue compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Lens CAS ${spaceId}`},${`lens-${spaceId}`},now())`
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${pagingSpaceId}::uuid,${`Lens paging ${pagingSpaceId}`},${`lens-paging-${pagingSpaceId}`},now())`
      await sql`INSERT INTO project (id,space_id,name,created_at) VALUES (${projectId}::uuid,${spaceId}::uuid,'lens-cas-project',now())`
    } finally {
      await sql.close()
    }
  })

  test('pages lens rows sharing one transaction timestamp exactly once and terminates', async () => {
    const ids = Array.from({ length: 5 }, () => newRecordId())
    const sql = new SQL(url!)
    try {
      await sql.begin(async (tx) => {
        for (const [index, id] of ids.entries())
          await tx`INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at) VALUES (${id}::uuid,${pagingSpaceId}::uuid,${`page-${index}`},'Paging','Question?','Nothing.','{}',1,true,false,now())`
      })
    } finally {
      await sql.close()
    }

    const seen: string[] = []
    const app = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    registerRecordLensRoutes(
      app,
      {
        listLensCatalogue: listRecordLensCatalogue,
        upsertLens: async () => null,
        upsertLensProfile: async () => null,
        selectProjectLensProfile: async () => null,
      },
      { scope: () => ({ ...tenant(), spaceId: pagingSpaceId }), noSpace: () => new Response() },
    )
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const response = await app.request(
        `/v1/lens-catalogue/lens?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      const page = (await response.json()) as {
        items: { id: string }[]
        nextCursor: string | null
      }
      pages++
      seen.push(...page.items.map((item) => String(item.id)))
      if (!page.nextCursor) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(4)
    }
    expect(pages).toBe(3)
    expect(new Set(seen)).toEqual(new Set(ids))
    expect(seen).toHaveLength(ids.length)
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
      selectedVersionId: null,
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

  test('a hosted profile version keeps its current id when it becomes a revision', async () => {
    const lensKey = 'stable-profile-version-id'
    await upsertRecordLens({
      ...tenant(),
      key: lensKey,
      title: 'Stable profile version id',
      question: 'Stable?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'create lens',
    })
    const input = {
      ...tenant(),
      lensKey,
      axis: 'framework' as const,
      name: 'default',
      body: '{}',
      enabled: true,
      expectedVersion: null,
      reason: 'create version one',
    }
    const versionOne = await upsertRecordLensProfile(input)
    const versionTwo = await upsertRecordLensProfile({
      ...input,
      expectedVersion: 1,
      reason: 'create version two',
    })
    await upsertRecordLensProfile({
      ...input,
      expectedVersion: 2,
      reason: 'create version three',
    })

    const sql = new SQL(url!)
    try {
      expect(
        await sql`SELECT version,id::text id FROM lens_profile_revision WHERE profile_id=${versionOne.profile.id}::uuid ORDER BY version`,
      ).toEqual([
        { version: 1, id: versionOne.profile.currentVersionId },
        { version: 2, id: versionTwo.profile.currentVersionId },
      ])
    } finally {
      await sql.close()
    }
  })

  test('hosted profile revisions skip an appended version and preserve its pinned id', async () => {
    const lensKey = `appended-profile-version-${newRecordId()}`
    await upsertRecordLens({
      ...tenant(),
      key: lensKey,
      title: 'Appended profile version',
      question: 'Stable?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'create lens',
    })
    const profileInput = {
      ...tenant(),
      lensKey,
      axis: 'framework' as const,
      name: 'default',
      body: '{"source":"hosted-v1"}',
      enabled: true,
      expectedVersion: null,
      reason: 'create version one',
    }
    await upsertRecordLensProfile(profileInput)
    const hostedVersionTwo = await upsertRecordLensProfile({
      ...profileInput,
      body: '{"source":"hosted-v2"}',
      expectedVersion: 1,
      reason: 'create version two',
    })
    const pushedLensId = newRecordId(),
      pushedProfileId = newRecordId(),
      appendedVersionId = newRecordId(),
      selectionId = newRecordId(),
      at = new Date().toISOString()
    await importRecordLensCatalogue({
      ...tenant(),
      dryRun: false,
      lens: [
        {
          id: pushedLensId,
          spaceId,
          key: lensKey,
          title: 'Pushed',
          question: 'Pushed?',
          excludes: 'Nothing.',
          slots: '{}',
          version: 1,
          enabled: true,
          requiresExecution: false,
          updatedAt: at,
        },
      ],
      lens_revision: [],
      lens_profile: [
        {
          id: pushedProfileId,
          spaceId,
          lensId: pushedLensId,
          axis: 'framework',
          name: 'default',
          version: 2,
          currentVersionId: appendedVersionId,
          body: '{"source":"appended-v2"}',
          enabled: true,
          updatedAt: at,
        },
      ],
      lens_profile_revision: [],
      project_lens_profile: [
        {
          id: selectionId,
          spaceId,
          projectId,
          lensId: pushedLensId,
          axis: 'framework',
          profileName: 'default',
          selectedVersion: 2,
          selectedVersionId: appendedVersionId,
          selectionVersion: 1,
          updatedAt: at,
        },
      ],
      project_lens_profile_revision: [],
    })
    const versionFour = await upsertRecordLensProfile({
      ...profileInput,
      body: '{"source":"hosted-v4"}',
      expectedVersion: 2,
      reason: 'create version four',
    })
    await upsertRecordLensProfile({
      ...profileInput,
      body: '{"source":"hosted-v5"}',
      expectedVersion: 4,
      reason: 'create version five',
    })

    const sql = new SQL(url!)
    try {
      expect(
        await sql`SELECT version,id::text id FROM lens_profile_revision
          WHERE profile_id=${hostedVersionTwo.profile.id}::uuid ORDER BY version`,
      ).toEqual([
        expect.objectContaining({ version: 1 }),
        { version: 2, id: hostedVersionTwo.profile.currentVersionId },
        { version: 3, id: appendedVersionId },
        { version: 4, id: versionFour.profile.currentVersionId },
      ])
      expect(
        await sql`SELECT profile.version,revision.prior_body::jsonb->'body' body
          FROM project_lens_profile selection
          JOIN lens_profile profile ON profile.lens_id=selection.lens_id
            AND profile.axis=selection.axis AND profile.name=selection.profile_name
          JOIN lens_profile_revision revision ON revision.profile_id=profile.id
            AND revision.id=selection.selected_version_id
          WHERE selection.id=${selectionId}::uuid`,
      ).toEqual([{ version: 5, body: { source: 'appended-v2' } }])
    } finally {
      await sql.close()
    }
  })

  test('hosted selection derives an omitted version id and refuses disagreement', async () => {
    const lensKey = 'selection-version-id'
    await upsertRecordLens({
      ...tenant(),
      key: lensKey,
      title: 'Selection version id',
      question: 'Pinned?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'create selection lens',
    })
    const profileInput = {
      ...tenant(),
      lensKey,
      axis: 'architecture' as const,
      name: 'pinned',
      body: '{}',
      enabled: true,
      expectedVersion: null,
      reason: 'create selection profile',
    }
    const versionOne = await upsertRecordLensProfile(profileInput)
    const versionTwo = await upsertRecordLensProfile({
      ...profileInput,
      expectedVersion: 1,
      reason: 'revise selection profile',
    })
    const selection = {
      ...tenant(),
      projectId,
      lensKey,
      axis: 'architecture' as const,
      profileName: 'pinned',
      selectedVersion: 1,
      selectedVersionId: null,
      expectedSelectionVersion: null,
      reason: 'older client pin',
    }
    const written = await selectRecordProjectLensProfile(selection)
    expect(written.selection.selectedVersionId).toBe(versionOne.profile.currentVersionId)

    await expect(
      selectRecordProjectLensProfile({
        ...selection,
        selectedVersionId: String(versionTwo.profile.currentVersionId),
      }),
    ).rejects.toThrow(
      `selected version 1 and selected version id ${versionTwo.profile.currentVersionId} name different versions`,
    )
    await expect(selectRecordProjectLensProfile({ ...selection, lensKey: null })).rejects.toThrow(
      "a pinned version names one lens profile's version; pass --lens <key> with --version",
    )
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
    expect(rejected?.status).toBe('rejected')
    const reason = (rejected as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(RecordLensError)
    expect(reason.status).toBe(409)
  })

  test('selection refuses missing profiles, missing versions, and disabled historical versions without writes', async () => {
    const lensKey = 'selection-validation-lens'
    await upsertRecordLens({
      ...tenant(),
      key: lensKey,
      title: 'Selection validation',
      question: 'Valid?',
      excludes: 'Nothing.',
      slots: '{}',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'create',
    })
    await upsertRecordLensProfile({
      ...tenant(),
      lensKey,
      axis: 'architecture',
      name: 'historical',
      body: '{}',
      enabled: false,
      expectedVersion: null,
      reason: 'create disabled history',
    })
    await upsertRecordLensProfile({
      ...tenant(),
      lensKey,
      axis: 'architecture',
      name: 'historical',
      body: '{}',
      enabled: true,
      expectedVersion: 1,
      reason: 'enable current',
    })
    const selection = {
      ...tenant(),
      projectId,
      lensKey,
      axis: 'architecture' as const,
      profileName: 'historical',
      selectedVersion: 1,
      selectedVersionId: null,
      expectedSelectionVersion: null,
      reason: 'invalid selection',
    }

    await expect(selectRecordProjectLensProfile(selection)).rejects.toMatchObject({ status: 422 })
    await expect(
      selectRecordProjectLensProfile({
        ...selection,
        profileName: 'missing',
        selectedVersion: null,
      }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      selectRecordProjectLensProfile({ ...selection, selectedVersion: 99 }),
    ).rejects.toMatchObject({ status: 422 })

    const sql = new SQL(url!)
    try {
      const [counts] = await sql`SELECT
        (SELECT count(*)::integer FROM project_lens_profile selection
          JOIN lens ON lens.id=selection.lens_id
          WHERE selection.space_id=${spaceId}::uuid AND selection.project_id=${projectId}::uuid
            AND lens.key=${lensKey}) selections,
        (SELECT count(*)::integer FROM project_lens_profile_revision revision
          JOIN project_lens_profile selection ON selection.id=revision.selection_id
          JOIN lens ON lens.id=selection.lens_id
          WHERE revision.space_id=${spaceId}::uuid AND selection.project_id=${projectId}::uuid
            AND lens.key=${lensKey}) revisions`
      expect(counts).toEqual({ selections: 0, revisions: 0 })
    } finally {
      await sql.close()
    }
  })
})
