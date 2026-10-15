import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'

export async function proveHostedDocOrder(input: {
  origin: string
  token: string
  otherSpaceId: string
}): Promise<void> {
  const headers = {
    Authorization: `Bearer ${input.token}`,
    'content-type': 'application/json',
  }
  const proof = newRecordId()
  const create = async (
    slug: string,
    title: string,
    parentRecordId: string | null,
    position: number,
    requestHeaders: Record<string, string> = headers,
  ) => {
    const response = await fetch(`${input.origin}/v1/docs`, {
      method: 'PUT',
      headers: requestHeaders,
      body: JSON.stringify({
        scope: 'machine',
        subject: null,
        slug: `${slug}-${proof}`,
        title,
        body: 'document order proof',
        delivery: 'inject',
        parentRecordId,
        position,
        reason: 'prove hosted document order',
        author: 'proof',
      }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { id: string }
  }
  const parent = await create('order-parent', 'Order parent', null, 0)
  const first = await create('order-first', 'First', parent.id, 0)
  const second = await create('order-second', 'Second', parent.id, 1)
  const third = await create('order-third', 'Third', parent.id, 2)
  const otherHeaders = { ...headers, 'x-record-space': input.otherSpaceId }
  const other = await create('order-other-space', 'Other space', null, 41, otherHeaders)
  const read = async (id: string, requestHeaders: Record<string, string> = headers) => {
    const response = await fetch(`${input.origin}/v1/docs/${id}`, { headers: requestHeaders })
    expect(response.status).toBe(200)
    return (await response.json()) as { id: string; position: number }
  }
  const positions = async () =>
    Promise.all([first.id, second.id, third.id].map(async (id) => (await read(id)).position))
  const orderedIds = [third.id, first.id, second.id]
  const reordered = await fetch(`${input.origin}/v1/docs/order`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      parentId: parent.id,
      orderedIds,
    }),
  })
  expect(reordered.status).toBe(200)
  expect(await reordered.json()).toEqual({ orderedIds })
  expect(await positions()).toEqual([1, 2, 0])

  const beforeRefusal = await positions()
  const refused = await fetch(`${input.origin}/v1/docs/order`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'machine',
      subject: null,
      parentId: parent.id,
      orderedIds: orderedIds.slice(0, 2),
    }),
  })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining('missing ids') })
  expect(await positions()).toEqual(beforeRefusal)
  expect((await read(other.id, otherHeaders)).position).toBe(41)
}
