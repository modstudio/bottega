import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { db } from '../src/db.ts'
import type { RecordApiClient } from '../src/record-api-client.ts'
import { pullRecordCache } from '../src/record-cache.ts'
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
    deleteDoc: unused,
    consumeDoc: unused,
    restoreDoc: unused,
    renameSubject: unused,
    putScore: unused,
    voidRun: unused,
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

  const runId = newRecordId()
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
}
