import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { db } from '../src/database/db.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'
import { pullRecordCache } from '../src/record/record-cache.ts'
import { succeeds } from './fixtures/postgres-rls.ts'
import { createMemoryRecordApiClient, installRecordApiClient } from './fixtures/record-api.ts'

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
    whoami: unused,
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
    importDoc: unused,
    deleteDoc: unused,
    consumeDoc: unused,
    restoreDoc: unused,
    renameSubject: unused,
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
    body: JSON.stringify({ reason: 'hide it', author: 'proof' }),
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
