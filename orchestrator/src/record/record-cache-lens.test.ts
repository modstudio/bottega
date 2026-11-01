import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { resolveLens } from '../lens/lenses.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { pullRecordCache } from './record-cache.ts'
import { applyLensCatalogueRow, pullLensCatalogue } from './record-cache-lens.ts'
import { encodeRecordCursor } from './record-cursor.ts'

afterEach(() => installRecordApiClient(createMemoryRecordApiClient()))

const row = (key: string, id = newRecordId()) => ({
  id,
  spaceId: newRecordId(),
  key,
  title: `Hosted ${key}`,
  question: 'Hosted question?',
  excludes: 'Other concerns.',
  slots: '{"type":"object","properties":{},"additionalProperties":false}',
  version: 4,
  enabled: true,
  requiresExecution: false,
  updatedAt: new Date().toISOString(),
})

const profileRow = (spaceId: string, lensId: string, body: string, id = newRecordId()) => ({
  id,
  spaceId,
  lensId,
  axis: 'framework',
  name: 'default',
  version: 1,
  currentVersionId: newRecordId(),
  body,
  enabled: true,
  updatedAt: new Date().toISOString(),
})

type CatalogueIds = {
  extraLens: string
  lens: string
  lensRevision: string
  profile: string
  profileRevision: string
  selection: string
  selectionRevision: string
}

function catalogueItem(
  table: string,
  space: string,
  ids: CatalogueIds,
  projectId: string,
  at: string,
): Record<string, unknown> {
  if (table === 'lens') return { ...row('pulled-lens', ids.lens), spaceId: space, updatedAt: at }
  if (table === 'lens_revision')
    return {
      id: ids.lensRevision,
      spaceId: space,
      lensId: ids.lens,
      version: 1,
      priorBody: '{}',
      reason: 'pull',
      sessionId: null,
      at,
    }
  if (table === 'lens_profile') return profileRow(space, ids.lens, '{}', ids.profile)
  if (table === 'lens_profile_revision')
    return {
      id: ids.profileRevision,
      spaceId: space,
      profileId: ids.profile,
      version: 1,
      priorBody: '{}',
      reason: 'pull',
      sessionId: null,
      at,
    }
  if (table === 'project_lens_profile')
    return {
      id: ids.selection,
      spaceId: space,
      projectId,
      lensId: ids.lens,
      axis: 'framework',
      profileName: 'default',
      selectedVersion: null,
      selectionVersion: 1,
      updatedAt: at,
    }
  return {
    id: ids.selectionRevision,
    spaceId: space,
    selectionId: ids.selection,
    priorProfileName: null,
    priorSelectedVersion: null,
    reason: 'pull',
    sessionId: null,
    at,
  }
}

test('lens cache reconciles hosted rows within their space and preserves the local catalogue', () => {
  const local = db()
  const byId = row('hosted-by-id')
  local
    .query(
      "INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,?,'old-key','Old','Q','E','{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}',1,1,0)",
    )
    .run(byId.id, byId.spaceId)
  applyLensCatalogueRow(local, 'lens', byId)
  expect(local.query("SELECT title FROM lens WHERE id='old-key'").get()).toEqual({
    title: 'Hosted hosted-by-id',
  })

  const natural = row('natural-key')
  local
    .query(
      "INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution) VALUES (?,?,'natural-key','Old','Q','E','{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}',1,1,0)",
    )
    .run(newRecordId(), natural.spaceId)
  applyLensCatalogueRow(local, 'lens', natural)
  expect(local.query("SELECT record_id FROM lens WHERE id='natural-key'").get()).toEqual({
    record_id: natural.id,
  })

  const inserted = row('inserted-key')
  applyLensCatalogueRow(local, 'lens', inserted)
  expect(local.query("SELECT record_id FROM lens WHERE id='inserted-key'").get()).toEqual({
    record_id: inserted.id,
  })

  const pulledProfile = profileRow(inserted.spaceId, inserted.id, '{}')
  applyLensCatalogueRow(local, 'lens_profile', pulledProfile)
  expect(
    local
      .query('SELECT current_version_id FROM lens_profile WHERE record_id=?')
      .get(pulledProfile.id),
  ).toEqual({ current_version_id: pulledProfile.currentVersionId })

  const localSeed = local
    .query<{ record_id: string; title: string }, []>(
      "SELECT record_id,title FROM lens WHERE id='correctness' AND space_id IS NULL",
    )
    .get()!
  const seeded = row('correctness')
  const localTitle = localSeed.title
  applyLensCatalogueRow(local, 'lens', seeded)
  expect(local.query("SELECT COUNT(*) AS n FROM lens WHERE id='correctness'").get()).toEqual({
    n: 2,
  })
  expect(
    local
      .query("SELECT record_id FROM lens WHERE id='correctness' AND space_id=?")
      .get(seeded.spaceId),
  ).toEqual({ record_id: seeded.id })
  expect(resolveLens('correctness', null, local)).toMatchObject({ title: localTitle })
})

test('lens cache adopts hosted UUIDs and cascades them through every child relationship', () => {
  const local = db()
  const spaceId = newRecordId()
  const oldLens = { ...row('adopted-lens'), id: newRecordId(), spaceId }
  const oldProfile = profileRow(spaceId, oldLens.id, '{}', newRecordId())
  const revisionAt = '2026-10-19T12:00:00.000Z'
  const oldLensRevision = {
    id: newRecordId(),
    spaceId,
    lensId: oldLens.id,
    version: 1,
    priorBody: '{}',
    reason: 'old lens revision',
    sessionId: null,
    at: revisionAt,
  }
  const oldProfileRevision = {
    id: newRecordId(),
    spaceId,
    profileId: oldProfile.id,
    version: 1,
    priorBody: '{}',
    reason: 'old profile revision',
    sessionId: null,
    at: revisionAt,
  }
  const projectId = newRecordId()
  const oldSelection = {
    id: newRecordId(),
    spaceId,
    projectId,
    lensId: null,
    axis: 'framework',
    profileName: 'default',
    selectedVersion: null,
    selectionVersion: 1,
    updatedAt: revisionAt,
  }
  const oldSelectionRevision = {
    id: newRecordId(),
    spaceId,
    selectionId: oldSelection.id,
    priorProfileName: null,
    priorSelectedVersion: null,
    reason: 'old selection revision',
    sessionId: null,
    at: revisionAt,
  }
  applyLensCatalogueRow(local, 'lens', oldLens)
  applyLensCatalogueRow(local, 'lens_revision', oldLensRevision)
  applyLensCatalogueRow(local, 'lens_profile', oldProfile)
  applyLensCatalogueRow(local, 'lens_profile_revision', oldProfileRevision)
  applyLensCatalogueRow(local, 'project_lens_profile', oldSelection)
  applyLensCatalogueRow(local, 'project_lens_profile_revision', oldSelectionRevision)

  const lensId = newRecordId()
  applyLensCatalogueRow(local, 'lens', { ...oldLens, id: lensId })
  expect(
    local.query('SELECT lens_record_id FROM lens_profile WHERE record_id=?').get(oldProfile.id),
  ).toEqual({ lens_record_id: lensId })

  const lensRevisionId = newRecordId()
  applyLensCatalogueRow(local, 'lens_revision', {
    ...oldLensRevision,
    id: lensRevisionId,
    lensId,
  })
  expect(
    local.query('SELECT record_id FROM lens_revision WHERE lens_record_id=?').get(lensId),
  ).toEqual({ record_id: lensRevisionId })

  const profileId = newRecordId()
  applyLensCatalogueRow(local, 'lens_profile', { ...oldProfile, id: profileId, lensId })
  expect(
    local
      .query('SELECT profile_record_id FROM lens_profile_revision WHERE record_id=?')
      .get(oldProfileRevision.id),
  ).toEqual({ profile_record_id: profileId })
  const profileRevisionId = newRecordId()
  applyLensCatalogueRow(local, 'lens_profile_revision', {
    ...oldProfileRevision,
    id: profileRevisionId,
    profileId,
  })
  expect(
    local
      .query('SELECT record_id FROM lens_profile_revision WHERE profile_record_id=?')
      .get(profileId),
  ).toEqual({ record_id: profileRevisionId })

  const selectionId = newRecordId()
  applyLensCatalogueRow(local, 'project_lens_profile', { ...oldSelection, id: selectionId })
  expect(
    local
      .query('SELECT selection_record_id FROM project_lens_profile_revision WHERE record_id=?')
      .get(oldSelectionRevision.id),
  ).toEqual({ selection_record_id: selectionId })
  const selectionRevisionId = newRecordId()
  applyLensCatalogueRow(local, 'project_lens_profile_revision', {
    ...oldSelectionRevision,
    id: selectionRevisionId,
    selectionId,
  })
  expect(
    local
      .query('SELECT record_id FROM project_lens_profile_revision WHERE selection_record_id=?')
      .get(selectionId),
  ).toEqual({ record_id: selectionRevisionId })
})

test('two spaces keep the same lens key isolated after later hosted revisions', () => {
  const local = db()
  const spaceA = newRecordId()
  const spaceB = newRecordId()
  const lensA = { ...row('shared-lens'), spaceId: spaceA, title: 'Space A' }
  const lensB = { ...row('shared-lens'), spaceId: spaceB, title: 'Space B' }
  lensA.slots = lensB.slots =
    '{"type":"object","properties":{"guidance":{"type":"string"}},"additionalProperties":false}'
  applyLensCatalogueRow(local, 'lens', lensA)
  applyLensCatalogueRow(local, 'lens', lensB)
  const profileA = profileRow(spaceA, lensA.id, '{"guidance":"A first"}')
  const profileB = profileRow(spaceB, lensB.id, '{"guidance":"B first"}')
  applyLensCatalogueRow(local, 'lens_profile', profileA)
  applyLensCatalogueRow(local, 'lens_profile', profileB)
  upsertProject({ recordId: newRecordId(), name: 'space-a-project', path: '/tmp/a', settings: {} })
  upsertProject({ recordId: newRecordId(), name: 'space-b-project', path: '/tmp/b', settings: {} })
  rememberProjectSpace(local, 'space-a-project', spaceA)
  rememberProjectSpace(local, 'space-b-project', spaceB)

  expect(resolveLens('shared-lens', 'space-a-project')?.body).toBe('GUIDANCE\nA first')
  expect(resolveLens('shared-lens', 'space-b-project')?.body).toBe('GUIDANCE\nB first')

  applyLensCatalogueRow(local, 'lens', { ...lensB, version: 5, title: 'Space B later' })
  applyLensCatalogueRow(local, 'lens_profile', {
    ...profileB,
    version: 2,
    body: '{"guidance":"B later"}',
  })
  expect(resolveLens('shared-lens', 'space-a-project')?.body).toBe('GUIDANCE\nA first')
  expect(resolveLens('shared-lens', 'space-b-project')).toMatchObject({
    title: 'Space B later',
    body: 'GUIDANCE\nB later',
  })
})

test('lens pull caches an unregistered project selection and revision from a persisted cursor', async () => {
  const local = db()
  local.query('DELETE FROM project').run()
  const space = newRecordId()
  const project = newRecordId()
  const lens = newRecordId()
  const selection = newRecordId()
  const revision = newRecordId()
  const selectedVersionId = newRecordId()
  const priorSelectedVersionId = newRecordId()
  const pulledAt = '2026-10-19T12:00:00.000Z'
  const cursorKey = `record_lens_cursor:${space}:project_lens_profile`
  local
    .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
    .run(cursorKey, JSON.stringify({ at: '2026-10-18T00:00:00.000Z', id: newRecordId() }))
  let selectionCursor: string | undefined
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listLensCatalogue(table, query) {
      if (table === 'lens')
        return {
          items: [{ ...row('pinned-lens', lens), spaceId: space, updatedAt: pulledAt }],
          nextCursor: null,
        }
      if (table === 'project_lens_profile') {
        selectionCursor = query.cursor
        return {
          items: [
            {
              id: selection,
              spaceId: space,
              projectId: project,
              lensId: lens,
              axis: 'framework',
              profileName: 'default',
              selectedVersion: 2,
              selectedVersionId,
              selectionVersion: 1,
              updatedAt: pulledAt,
            },
          ],
          nextCursor: null,
        }
      }
      if (table === 'project_lens_profile_revision')
        return {
          items: [
            {
              id: revision,
              spaceId: space,
              selectionId: selection,
              priorProfileName: null,
              priorSelectedVersion: 1,
              priorSelectedVersionId,
              reason: 'pull',
              sessionId: null,
              at: pulledAt,
            },
          ],
          nextCursor: null,
        }
      return { items: [], nextCursor: null }
    },
  })

  expect(await pullLensCatalogue(local, [space])).toBe(3)
  expect(selectionCursor).toBeDefined()
  expect(
    local
      .query(
        'SELECT project_record_id,selected_version_id FROM project_lens_profile WHERE record_id=?',
      )
      .get(selection),
  ).toEqual({ project_record_id: project, selected_version_id: selectedVersionId })
  expect(
    local
      .query(
        'SELECT prior_selected_version_id FROM project_lens_profile_revision WHERE record_id=?',
      )
      .get(revision),
  ).toEqual({ prior_selected_version_id: priorSelectedVersionId })

  const repinned = newRecordId()
  applyLensCatalogueRow(local, 'project_lens_profile', {
    id: selection,
    spaceId: space,
    projectId: project,
    lensId: lens,
    axis: 'framework',
    profileName: 'default',
    selectedVersion: 3,
    selectedVersionId: repinned,
    selectionVersion: 2,
    updatedAt: '2026-10-19T13:00:00.000Z',
  })
  expect(
    local
      .query('SELECT selected_version_id FROM project_lens_profile WHERE record_id=?')
      .get(selection),
  ).toEqual({ selected_version_id: repinned })
})

test('pullRecordCache pages six parent-first streams with independent space and table cursors', async () => {
  const local = db()
  const spaceA = '01990000-0000-7000-8000-0000000000a1'
  const spaceB = '01990000-0000-7000-8000-0000000000b1'
  const projectA = newRecordId()
  const projectB = newRecordId()
  upsertProject({ recordId: projectA, name: 'pull-a', path: '/tmp/pull-a', settings: {} })
  upsertProject({
    recordId: projectB,
    name: 'pull-b',
    path: '/tmp/pull-b',
    settings: { space: 'b' },
  })
  const ids = new Map<string, CatalogueIds>()
  for (const space of [spaceA, spaceB])
    ids.set(space, {
      extraLens: newRecordId(),
      lens: newRecordId(),
      lensRevision: newRecordId(),
      profile: newRecordId(),
      profileRevision: newRecordId(),
      selection: newRecordId(),
      selectionRevision: newRecordId(),
    })
  const calls: string[] = []
  const at = '2026-10-18T12:00:00.000Z'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId(), email: 'pull@example.test' },
      activeSpaceId: spaceA,
      personalSpaceId: spaceA,
      memberships: [
        { space_id: spaceA, slug: 'a', permission: 'write' },
        { space_id: spaceB, slug: 'b', permission: 'write' },
      ],
    }),
    listLensCatalogue: async (table, query, destination) => {
      const space = destination?.destinationSpaceId ?? ''
      const key = `${space}:${table}`
      calls.push(`${key}:${query.cursor ? 'resume' : 'start'}`)
      const rowIds = ids.get(space)!
      const projectId = space === spaceA ? projectA : projectB
      if (table === 'lens' && space === spaceA && !query.cursor)
        return {
          items: [
            {
              ...row('page-one', rowIds.extraLens),
              spaceId: space,
              updatedAt: at,
            },
          ],
          nextCursor: encodeRecordCursor({ at, id: rowIds.extraLens }),
          endCursor: encodeRecordCursor({ at, id: rowIds.extraLens }),
        }
      const item = catalogueItem(table, space, rowIds, projectId, at)
      return {
        items: [item],
        nextCursor: null,
        endCursor: encodeRecordCursor({ at, id: String(item.id) }),
      }
    },
  })

  expect((await pullRecordCache(local)).lensCatalogue).toBe(13)
  expect(calls).toEqual([
    `${spaceA}:lens:start`,
    `${spaceA}:lens:resume`,
    ...[
      'lens_revision',
      'lens_profile',
      'lens_profile_revision',
      'project_lens_profile',
      'project_lens_profile_revision',
    ].map((table) => `${spaceA}:${table}:start`),
    ...[
      'lens',
      'lens_revision',
      'lens_profile',
      'lens_profile_revision',
      'project_lens_profile',
      'project_lens_profile_revision',
    ].map((table) => `${spaceB}:${table}:start`),
  ])
  expect(
    local
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM schema_meta WHERE key LIKE 'record_lens_cursor:%'",
      )
      .get()!.n,
  ).toBe(12)
})

test('an unresolved child rolls back its stream cursor', async () => {
  const local = db()
  const space = '01990000-0000-7000-8000-0000000000c1'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId(), email: 'pull@example.test' },
      activeSpaceId: space,
      personalSpaceId: space,
      memberships: [{ space_id: space, slug: 'c', permission: 'write' }],
    }),
    listLensCatalogue: async (table) => ({
      items:
        table === 'lens_revision'
          ? [
              {
                id: newRecordId(),
                spaceId: space,
                lensId: newRecordId(),
                version: 1,
                priorBody: '{}',
                reason: 'unresolved',
                sessionId: null,
                at: '2026-10-18T12:00:00.000Z',
              },
            ]
          : [],
      nextCursor: null,
    }),
  })
  await expect(pullRecordCache(local)).rejects.toThrow('could not resolve lens parent')
  expect(
    local
      .query(
        "SELECT value FROM schema_meta WHERE key='record_lens_cursor:01990000-0000-7000-8000-0000000000c1:lens_revision'",
      )
      .get(),
  ).toBeNull()
})

test('a failed lens pull keeps project routing on the prior complete catalogue', async () => {
  const local = db()
  const oldSpace = '01990000-0000-7000-8000-0000000000d1'
  const newSpace = '01990000-0000-7000-8000-0000000000d2'
  const projectId = newRecordId()
  upsertProject({
    recordId: projectId,
    name: 'moving-project',
    path: '/tmp/moving-project',
    settings: { space: 'new-space' },
  })
  const oldLens = {
    ...row('routed-lens'),
    spaceId: oldSpace,
    slots:
      '{"type":"object","properties":{"guidance":{"type":"string"}},"additionalProperties":false}',
  }
  applyLensCatalogueRow(local, 'lens', oldLens)
  applyLensCatalogueRow(
    local,
    'lens_profile',
    profileRow(oldSpace, oldLens.id, '{"guidance":"prior complete catalogue"}'),
  )
  rememberProjectSpace(local, 'moving-project', oldSpace)

  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId(), email: 'pull@example.test' },
      activeSpaceId: oldSpace,
      personalSpaceId: oldSpace,
      memberships: [
        { space_id: oldSpace, slug: 'old-space', permission: 'write' },
        { space_id: newSpace, slug: 'new-space', permission: 'write' },
      ],
    }),
    listLensCatalogue: async (table, _query, destination) => {
      if (destination?.destinationSpaceId === newSpace && table === 'lens_profile')
        throw new Error('lens pull interrupted')
      return { items: [], nextCursor: null }
    },
  })

  expect(resolveLens('routed-lens', 'moving-project', local)?.body).toContain(
    'prior complete catalogue',
  )
  await expect(pullRecordCache(local)).rejects.toThrow('lens pull interrupted')
  expect(resolveLens('routed-lens', 'moving-project', local)?.body).toContain(
    'prior complete catalogue',
  )
})
