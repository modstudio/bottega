import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'

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
}
