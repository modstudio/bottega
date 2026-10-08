import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { db } from '../src/database/db.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'
import { pullRecordCache } from '../src/record/record-cache.ts'
import { psql, succeeds } from './fixtures/postgres-rls.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
  unusedBoardClientMethods,
} from './fixtures/record-api.ts'

function unused(): Promise<never> {
  return Promise.reject(new Error('unused in cache-pull proof'))
}

function liveCacheClient(origin: string, token: string): RecordApiClient {
  const headers = { Authorization: `Bearer ${token}` }
  const read = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { headers })
    if (!response.ok) throw new Error(`${path} ${response.status}`)
    return response.json() as Promise<{
      items: Record<string, unknown>[]
      nextCursor: string | null
    }>
  }
  return {
    ...unusedBoardClientMethods(),
    whoami: unused,
    inviteMember: unused,
    putSnapshot: unused,
    listSnapshots: unused,
    listDocs: async (query) => {
      const search = new URLSearchParams()
      if (query.scope) search.set('scope', query.scope)
      if (query.subject !== undefined) search.set('subject', query.subject ?? '')
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      if (query.includeDeleted) search.set('includeDeleted', 'true')
      const suffix = search.toString()
      return read(`/v1/docs${suffix ? `?${suffix}` : ''}`)
    },
    listScores: async (query) => {
      const search = new URLSearchParams()
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      const suffix = search.toString()
      return read(`/v1/scores${suffix ? `?${suffix}` : ''}`)
    },
    getDoc: unused,
    listRevisions: unused,
    upsertDoc: unused,
    applySettingsPermission: unused,
    importDoc: unused,
    importCanon: unused,
    deleteDoc: unused,
    consumeDoc: unused,
    restoreDoc: unused,
    renameSubject: unused,
    upsertProject: unused,
    listProjects: unused,
    retireProject: unused,
    putScore: unused,
    voidRun: unused,
    unvoidRun: unused,
    counts: unused,
  }
}

async function proveCanonRefusal(origin: string, headers: Record<string, string>): Promise<void> {
  const canon = await fetch(`${origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/unlinted.md',
      title: 'No',
      body: 'Rule without required metadata.\n',
      delivery: 'demand',
      reason: 'prove canon refusal',
      author: 'proof',
    }),
  })
  expect(canon.status).toBe(400)
  expect(await canon.json()).toMatchObject({
    error: expect.stringContaining('refusing canon write'),
  })
}

type CanonProofAddress = { kind: 'user' } | { kind: 'project'; subject: string }
type CanonBatch = {
  rows: Array<{ slug: string; id: string; revisionId: string }>
  deletions: Array<{ slug: string; id: string; revisionId: string }>
  bootstrap: boolean
}

async function proveCanonImportAddress(
  origin: string,
  headers: Record<string, string>,
  address: CanonProofAddress,
): Promise<void> {
  const post = (
    rows: Array<{ slug: string; title: string; body: string }>,
    expectedRevisions = {},
  ) =>
    fetch(`${origin}/v1/docs/canon/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        address,
        rows,
        expectedRevisions,
        reason: 'canon batch proof',
        author: 'proof',
      }),
    })
  const entry = { slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Current guidance.\n' }
  const rule = {
    slug: '.agents/rules/proof.md',
    title: 'Proof rule',
    body: '---\ndescription: Proof rule\nalways: true\n---\n\nKeep this rule current.\n',
  }
  const empty = await post([])
  expect(empty.status).toBe(400)
  expect(await empty.json()).toMatchObject({ error: expect.stringContaining('empty canon import') })

  const created = await post([entry, rule])
  expect(created.status).toBe(200)
  const first = (await created.json()) as CanonBatch
  expect(first.bootstrap).toBe(true)
  expect(first.rows).toHaveLength(2)
  const revisions = Object.fromEntries(first.rows.map((row) => [row.slug, row.revisionId]))

  const refused = await post(
    [
      { ...entry, body: 'Changed guidance.\n' },
      { ...rule, body: `${rule.body}It used to differ.\n` },
    ],
    revisions,
  )
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining('canon/history') })
  const unchanged = await fetch(`${origin}/v1/docs/${first.rows[0]!.id}`, { headers })
  expect(((await unchanged.json()) as { body: string }).body).toBe(entry.body)

  const removed = await post([entry], revisions)
  expect(removed.status).toBe(200)
  const second = (await removed.json()) as CanonBatch
  expect(second.deletions.map(({ slug }) => slug)).toEqual([rule.slug])
  const deleted = await fetch(`${origin}/v1/docs/${first.rows[1]!.id}`, { headers })
  expect(((await deleted.json()) as { deletedAt: string | null }).deletedAt).toBeString()

  const remaining = second.rows.find(({ slug }) => slug === entry.slug)!
  const deleteLast = await fetch(`${origin}/v1/docs/${remaining.id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({
      reason: 'remove final canon row',
      author: 'proof',
      expectedRevision: remaining.revisionId,
    }),
  })
  expect(deleteLast.status).toBe(200)
  const regained = await post([{ ...entry, body: 'It used to differ.\n' }])
  expect(regained.status).toBe(400)
  expect(await regained.json()).toMatchObject({ error: expect.stringContaining('canon/history') })
}

async function proveCanonImports(origin: string, headers: Record<string, string>): Promise<void> {
  const subject = `canon-proof-${newRecordId()}`
  const project = await fetch(`${origin}/v1/projects`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: subject,
      path: `/tmp/${subject}`,
      stack: null,
      canon: true,
      settings: {},
      retiredAt: null,
    }),
  })
  expect(project.status).toBe(200)
  await proveCanonImportAddress(origin, headers, { kind: 'project', subject })
  await proveCanonImportAddress(origin, headers, { kind: 'user' })
}

async function proveDocumentStatus(
  origin: string,
  headers: Record<string, string>,
  spaceId: string,
): Promise<void> {
  const projectId = newRecordId()
  const projectName = `doc-status-proof-${projectId}`
  succeeds(
    'postgres',
    'postgres',
    `
      INSERT INTO project (id,space_id,name,key_prefixes,created_at)
      VALUES ('${projectId}','${spaceId}','${projectName}',ARRAY['STATUS'],now());
      INSERT INTO public_doc_space (space_id,project_id)
      VALUES ('${spaceId}','${projectId}');
    `,
  )

  const body = 'public lifecycle searchable proof'
  const put = async (slug: string, status: string, replacementSlug: string | null = null) => {
    const response = await fetch(`${origin}/v1/docs`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'project',
        subject: projectName,
        slug,
        title: slug === 'lifecycle' ? 'Lifecycle proof' : 'Replacement proof',
        body: slug === 'lifecycle' ? body : 'replacement destination',
        delivery: 'demand',
        audience: 'user',
        status,
        replacementSlug,
        projectName,
        reason: `prove ${status} document visibility`,
        author: 'proof',
      }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { id: string }
  }
  await put('replacement', 'current')
  const created = await put('lifecycle', 'current')

  const publicContains = async (path: string) => {
    const response = await fetch(`${origin}${path}`)
    expect(response.status).toBe(200)
    return ((await response.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === created.id,
    )
  }
  const signedContains = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { headers })
    expect(response.status).toBe(200)
    return ((await response.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === created.id,
    )
  }
  const expectPublicVisibility = async (visible: boolean) => {
    expect(await publicContains('/public/v1/docs')).toBe(visible)
    const detail = await fetch(`${origin}/public/v1/docs/${created.id}`)
    expect(detail.status).toBe(visible ? 200 : 404)
    expect(await publicContains('/public/v1/docs/search?q=lifecycle+searchable')).toBe(visible)
  }
  const expectSignedVisibility = async (status: string) => {
    expect(
      await signedContains(
        `/v1/docs?scope=project&subject=${encodeURIComponent(projectName)}&status=${status}`,
      ),
    ).toBe(true)
    const detail = await fetch(`${origin}/v1/docs/${created.id}`, { headers })
    expect(detail.status).toBe(200)
    expect((await detail.json()) as { status: string }).toMatchObject({ status })
  }

  await expectPublicVisibility(true)
  await expectSignedVisibility('current')
  await put('lifecycle', 'draft')
  await expectPublicVisibility(false)
  await expectSignedVisibility('draft')
  expect(await signedContains(`/v1/docs/search?q=lifecycle+searchable`)).toBe(false)
  expect(await signedContains(`/v1/docs/search?q=lifecycle+searchable&includeDrafts=true`)).toBe(
    true,
  )

  await put('lifecycle', 'superseded', 'replacement')
  await expectPublicVisibility(false)
  await expectSignedVisibility('superseded')
  await put('lifecycle', 'archived')
  await expectPublicVisibility(false)
  await expectSignedVisibility('archived')
  await put('lifecycle', 'current')
  await expectPublicVisibility(true)
  await expectSignedVisibility('current')

  for (const [table, invalidPair] of [
    ['doc', "status='superseded', replacement_slug=NULL"],
    ['doc', "status='current', replacement_slug='replacement'"],
    ['doc_revision', "status='superseded', replacement_slug=NULL"],
    ['doc_revision', "status='current', replacement_slug='replacement'"],
  ] as const) {
    const idColumn = table === 'doc' ? 'id' : 'doc_id'
    const result = psql(
      'postgres',
      'postgres',
      `UPDATE ${table} SET ${invalidPair} WHERE ${idColumn}='${created.id}';`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(`${table}_replacement_check`)
  }
}

async function proveCachePull(
  origin: string,
  token: string,
  headers: Record<string, string>,
): Promise<void> {
  const put = async (body: string) =>
    fetch(`${origin}/v1/docs`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'machine',
        subject: null,
        slug: 'cache-pull',
        title: 'Cache pull',
        body,
        delivery: 'inject',
        reason: 'cache pull proof',
        author: 'proof',
      }),
    })
  const created = await put('from-host')
  expect(created.status).toBe(200)
  const ids = (await created.json()) as { id: string }
  installRecordApiClient(liveCacheClient(origin, token))
  try {
    await pullRecordCache(db())
    expect(
      db().query<{ body: string }, [string]>('SELECT body FROM doc WHERE record_id=?').get(ids.id)
        ?.body,
    ).toBe('from-host')
    const updated = await put('updated-host')
    expect(updated.status).toBe(200)
    await pullRecordCache(db())
    expect(
      db().query<{ body: string }, [string]>('SELECT body FROM doc WHERE record_id=?').get(ids.id)
        ?.body,
    ).toBe('updated-host')
    const removed = await fetch(`${origin}/v1/docs/${ids.id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ reason: 'hide cache-pull', author: 'proof' }),
    })
    expect(removed.status).toBe(200)
    await pullRecordCache(db())
    expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(ids.id)).toBeNull()
  } finally {
    installRecordApiClient(createMemoryRecordApiClient())
  }
}

async function proveRequestedProjectSpace(
  origin: string,
  headers: Record<string, string>,
  activeSpaceId: string,
  destinationSpaceId: string,
): Promise<void> {
  const projectName = `routed-project-${newRecordId()}`
  const destinationHeaders = { ...headers, 'x-record-space': destinationSpaceId }
  const project = await fetch(`${origin}/v1/projects`, {
    method: 'PUT',
    headers: destinationHeaders,
    body: JSON.stringify({
      name: projectName,
      path: `/tmp/${projectName}`,
      stack: null,
      canon: false,
      settings: { space: destinationSpaceId },
      retiredAt: null,
    }),
  })
  expect(project.status).toBe(200)
  const document = await fetch(`${origin}/v1/docs`, {
    method: 'PUT',
    headers: destinationHeaders,
    body: JSON.stringify({
      scope: 'project',
      subject: projectName,
      slug: 'routed',
      title: 'Routed',
      body: 'two-space proof',
      delivery: 'demand',
      projectName,
      reason: 'prove project destination',
      author: 'proof',
    }),
  })
  expect(document.status).toBe(200)
  expect(
    succeeds(
      'postgres',
      'postgres',
      `SELECT count(*) FROM project WHERE space_id='${activeSpaceId}' AND name='${projectName}';
       SELECT count(*) FROM doc WHERE space_id='${activeSpaceId}' AND subject='${projectName}';
       SELECT count(*) FROM project WHERE space_id='${destinationSpaceId}' AND name='${projectName}';
       SELECT count(*) FROM doc WHERE space_id='${destinationSpaceId}' AND subject='${projectName}';`,
    ).split('\n'),
  ).toEqual(['0', '0', '1', '1'])

  const refusedName = `refused-project-${newRecordId()}`
  const refusedSpace = newRecordId()
  const refused = await fetch(`${origin}/v1/projects`, {
    method: 'PUT',
    headers: { ...headers, 'x-record-space': refusedSpace },
    body: JSON.stringify({
      name: refusedName,
      path: `/tmp/${refusedName}`,
      stack: null,
      canon: false,
      settings: {},
      retiredAt: null,
    }),
  })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({
    error: expect.stringContaining(refusedSpace),
  })
  expect(
    succeeds('postgres', 'postgres', `SELECT count(*) FROM project WHERE name='${refusedName}';`),
  ).toBe('0')
}

export async function proveHostedDocs(input: {
  origin: string
  token: string
  otherToken: string
}): Promise<void> {
  const headers = {
    Authorization: `Bearer ${input.token}`,
    'content-type': 'application/json',
  }
  const whoami = await fetch(`${input.origin}/v1/whoami`, { headers })
  expect(whoami.status).toBe(200)
  const identity = (await whoami.json()) as {
    user: { id: string }
    activeSpaceId: string
    personalSpaceId: string
  }
  expect(identity.activeSpaceId).toBe(identity.personalSpaceId)
  const memberSpaceId = newRecordId()
  succeeds(
    'postgres',
    'postgres',
    `
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${memberSpaceId}','docs-member-${memberSpaceId}','docs-member-${memberSpaceId}',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('${newRecordId()}','${memberSpaceId}','${identity.user.id}','member','write',now());
  `,
  )
  const selectSpace = async (spaceId: string) => {
    const response = await fetch(`${input.origin}/v1/active-space`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ spaceId }),
    })
    expect(response.status).toBe(200)
  }
  await proveRequestedProjectSpace(input.origin, headers, identity.personalSpaceId, memberSpaceId)
  await selectSpace(memberSpaceId)
  const put = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      slug: 'proof',
      title: 'Proof',
      body: 'hosted',
      delivery: 'inject',
      reason: 'postgres proof',
      author: 'proof',
    }),
  })
  expect(put.status).toBe(200)
  const created = (await put.json()) as { id: string; revisionId: string }
  expect(created.id).toBeString()
  expect(created.revisionId).toBeString()
  await proveDocumentStatus(input.origin, headers, memberSpaceId)
  const updated = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      slug: 'proof',
      title: 'Proof',
      body: 'hosted update',
      delivery: 'inject',
      reason: 'postgres compare-and-set proof',
      author: 'proof',
      expectedRevision: created.revisionId,
    }),
  })
  expect(updated.status).toBe(200)
  const updatedIds = (await updated.json()) as { revisionId: string }
  const timedWrite = async (body: string, expectedRevision: string, at?: string) => {
    const response = await fetch(`${input.origin}/v1/docs`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'machine',
        subject: null,
        slug: 'proof',
        title: 'Proof',
        body,
        delivery: 'inject',
        reason: `${body} compare-and-set proof`,
        author: 'proof',
        expectedRevision,
        at,
      }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { revisionId: string }
  }
  const backdated = await timedWrite('backdated', updatedIds.revisionId, '2000-01-01T00:00:00.000Z')
  const afterBackdated = await timedWrite('after backdated', backdated.revisionId)
  const futureDated = await timedWrite(
    'future dated',
    afterBackdated.revisionId,
    '2100-01-01T00:00:00.000Z',
  )
  const afterFutureDated = await timedWrite('after future dated', futureDated.revisionId)
  const stale = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      slug: 'proof',
      title: 'Proof',
      body: 'stale overwrite',
      delivery: 'inject',
      reason: 'postgres stale compare-and-set proof',
      author: 'proof',
      expectedRevision: created.revisionId,
    }),
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({
    error: expect.stringContaining(
      `expected revision ${created.revisionId}, current revision ${afterFutureDated.revisionId}`,
    ),
  })
  const settingsCreate = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'settings',
      subject: null,
      owner: identity.user.id,
      slug: 'settings',
      title: 'settings',
      body: '{"permissions":{},"hooks":{},"envKeys":[]}\n',
      delivery: 'demand',
      reason: 'postgres settings revision proof',
      author: 'proof',
    }),
  })
  expect(settingsCreate.status).toBe(200)
  const settingsCreated = (await settingsCreate.json()) as { revisionId: string }
  const settingsMissingRevision = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'settings',
      subject: null,
      owner: identity.user.id,
      slug: 'settings',
      title: 'settings',
      body: '{"permissions":{"allow":[]},"hooks":{},"envKeys":[]}\n',
      delivery: 'demand',
      reason: 'postgres missing settings revision proof',
      author: 'proof',
    }),
  })
  expect(settingsMissingRevision.status).toBe(409)
  expect(await settingsMissingRevision.json()).toMatchObject({
    error: expect.stringContaining(`current revision ${settingsCreated.revisionId}`),
  })
  await selectSpace(identity.personalSpaceId)
  const personalDefault = await fetch(`${input.origin}/v1/docs?scope=machine`, { headers })
  expect(personalDefault.status).toBe(200)
  expect(
    ((await personalDefault.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === created.id,
    ),
  ).toBe(false)
  const personalLens = await fetch(
    `${input.origin}/v1/docs?scope=machine&acrossReadableSpaces=true`,
    { headers },
  )
  expect(personalLens.status).toBe(200)
  expect(
    ((await personalLens.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === created.id,
    ),
  ).toBe(true)
  const personalDetail = await fetch(`${input.origin}/v1/docs/${created.id}`, { headers })
  expect(personalDetail.status).toBe(200)
  await selectSpace(memberSpaceId)

  const revisions = await fetch(`${input.origin}/v1/docs/${created.id}/revisions`, { headers })
  expect(revisions.status).toBe(200)
  expect(
    ((await revisions.json()) as { items: { id: string }[] }).items.some(
      (revision) => revision.id === created.revisionId,
    ),
  ).toBe(true)

  const listed = await fetch(`${input.origin}/v1/docs?scope=machine`, { headers })
  expect(listed.status).toBe(200)
  const page = (await listed.json()) as { items: { id: string; deletedAt: string | null }[] }
  expect(page.items.some((doc) => doc.id === created.id)).toBe(true)

  const removed = await fetch(`${input.origin}/v1/docs/${created.id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({
      reason: 'hide it',
      author: 'proof',
      expectedRevision: afterFutureDated.revisionId,
    }),
  })
  expect(removed.status).toBe(200)
  const hidden = await fetch(`${input.origin}/v1/docs?scope=machine`, { headers })
  const hiddenPage = (await hidden.json()) as { items: { id: string }[] }
  expect(hiddenPage.items.some((doc) => doc.id === created.id)).toBe(false)
  const withDeleted = await fetch(`${input.origin}/v1/docs?scope=machine&includeDeleted=true`, {
    headers,
  })
  expect(
    ((await withDeleted.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === created.id,
    ),
  ).toBe(true)

  const other = await fetch(`${input.origin}/v1/docs/${created.id}`, {
    headers: { Authorization: `Bearer ${input.otherToken}` },
  })
  expect(other.status).toBe(404)

  const inject = await fetch(`${input.origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'global',
      subject: null,
      slug: 'refused-inject',
      title: 'No',
      body: 'no',
      delivery: 'inject',
      reason: 'prove inject refusal',
      author: 'proof',
    }),
  })
  expect(inject.status).toBe(400)
  await proveCanonRefusal(input.origin, headers)
  await selectSpace(identity.personalSpaceId)
  await proveCanonImports(input.origin, headers)

  const runs = await fetch(`${input.origin}/v1/runs?limit=1`, { headers })
  expect(runs.status).toBe(200)
  const runId = ((await runs.json()) as { items: { id: string }[] }).items[0]?.id
  expect(runId).toBeString()
  const scored = await fetch(`${input.origin}/v1/runs/${runId}/score`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      delivery: 'full',
      quality: 'right',
      fidelity: null,
      note: 'proof',
      scoredAt: new Date().toISOString(),
      scoredBy: 'proof',
    }),
  })
  expect(scored.status).toBe(200)

  const missingRun = newRecordId()
  const voided = await fetch(`${input.origin}/v1/runs/${missingRun}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'void before run exists' }),
  })
  expect(voided.status).toBe(200)
  await proveCachePull(input.origin, input.token, headers)
  await proveDocImport(input.origin, headers)
}

function importBody(input: {
  slug: string
  body: string
  updatedAt: string
  deletedAt: string | null
  revisions: Array<{ body: string; op: string; at: string; reason: string }>
}) {
  const createdAt = input.revisions[0]?.at ?? input.updatedAt
  return {
    doc: {
      scope: 'machine',
      subject: null,
      slug: input.slug,
      title: 'Import',
      body: input.body,
      delivery: 'inject' as const,
      projectName: null,
      createdAt,
      updatedAt: input.updatedAt,
      deletedAt: input.deletedAt,
    },
    revisions: input.revisions.map((revision) => ({
      scope: 'machine',
      subject: null,
      slug: input.slug,
      op: revision.op,
      title: 'Import',
      body: revision.body,
      delivery: 'inject' as const,
      author: 'proof',
      reason: revision.reason,
      sessionId: null,
      at: revision.at,
    })),
  }
}

async function proveDocImport(origin: string, headers: Record<string, string>): Promise<void> {
  const older = '2026-01-01T00:00:00.000Z'
  const middle = '2026-01-01T12:00:00.000Z'
  const newer = '2026-01-02T00:00:00.000Z'
  const post = (body: unknown) =>
    fetch(`${origin}/v1/docs/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  const current = importBody({
    slug: 'import-current',
    body: 'current-body',
    updatedAt: newer,
    deletedAt: null,
    revisions: [
      { body: 'historical', op: 'create', at: older, reason: 'create it' },
      { body: 'historical', op: 'set', at: middle, reason: 'old revision' },
    ],
  })
  const created = await post(current)
  expect(created.status).toBe(200)
  const createdIds = (await created.json()) as { id: string; revisionIds: string[] }
  const hosted = await fetch(`${origin}/v1/docs/${createdIds.id}`, { headers })
  expect(hosted.status).toBe(200)
  expect(((await hosted.json()) as { body: string }).body).toBe('current-body')

  const refusedDeletion = await post(
    importBody({
      slug: 'import-current',
      body: 'current-body',
      updatedAt: newer,
      deletedAt: newer,
      revisions: [{ body: 'current-body', op: 'delete', at: newer, reason: 'remove current' }],
    }),
  )
  expect(refusedDeletion.status).toBe(409)
  expect(await refusedDeletion.json()).toEqual({
    error:
      'refusing import at machine//import-current: a deleted import never targets a live row; delete the live doc through the doc service first if deletion is intended',
  })
  const stillLive = await fetch(`${origin}/v1/docs/${createdIds.id}`, { headers })
  expect(stillLive.status).toBe(200)
  expect((await stillLive.json()) as { body: string; deletedAt: string | null }).toMatchObject({
    body: 'current-body',
    deletedAt: null,
  })

  const deletedPayload = importBody({
    slug: 'import-deleted',
    body: 'gone',
    updatedAt: newer,
    deletedAt: newer,
    revisions: [
      { body: 'gone', op: 'create', at: older, reason: 'create gone' },
      { body: 'gone', op: 'delete', at: newer, reason: 'remove gone' },
    ],
  })
  const deleted = await post(deletedPayload)
  expect(deleted.status).toBe(200)
  const deletedIds = (await deleted.json()) as { id: string }
  const deletedDoc = await fetch(`${origin}/v1/docs/${deletedIds.id}`, { headers })
  expect(((await deletedDoc.json()) as { deletedAt: string | null }).deletedAt).toBeString()
  const listed = await fetch(`${origin}/v1/docs?scope=machine`, { headers })
  expect(
    ((await listed.json()) as { items: { id: string }[] }).items.some(
      (doc) => doc.id === deletedIds.id,
    ),
  ).toBe(false)

  const beforeDoc = await (await fetch(`${origin}/v1/docs/${createdIds.id}`, { headers })).json()
  const beforeRevisions = await (
    await fetch(`${origin}/v1/docs/${createdIds.id}/revisions`, { headers })
  ).json()
  const again = await post(current)
  expect(again.status).toBe(200)
  expect(((await again.json()) as { id: string }).id).toBe(createdIds.id)
  const afterDoc = await (await fetch(`${origin}/v1/docs/${createdIds.id}`, { headers })).json()
  const afterRevisions = await (
    await fetch(`${origin}/v1/docs/${createdIds.id}/revisions`, { headers })
  ).json()
  expect(afterDoc).toEqual(beforeDoc)
  expect(afterRevisions).toEqual(beforeRevisions)

  const conflictSlug = 'import-conflict'
  const put = await fetch(`${origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      slug: conflictSlug,
      title: 'Conflict',
      body: 'hosted-new',
      delivery: 'inject',
      reason: 'seed newer hosted',
      author: 'proof',
    }),
  })
  expect(put.status).toBe(200)
  const conflict = await post(
    importBody({
      slug: conflictSlug,
      body: 'local-old',
      updatedAt: older,
      deletedAt: null,
      revisions: [{ body: 'local-old', op: 'create', at: older, reason: 'stale local' }],
    }),
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({
    error: expect.stringContaining('newer updated_at'),
  })
}
