import { expect } from 'bun:test'
import { succeeds } from './fixtures/postgres-rls.ts'

export async function proveEqualTimestampDocPaging(
  origin: string,
  headers: Record<string, string>,
): Promise<void> {
  const create = async (slug: string) => {
    const response = await fetch(`${origin}/v1/docs`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'machine',
        subject: null,
        slug,
        title: slug,
        body: slug,
        delivery: 'demand',
        reason: 'equal timestamp paging proof',
        author: 'proof',
      }),
    })
    expect(response.status).toBe(200)
    return String(((await response.json()) as { id: string }).id)
  }
  const ids = [await create('equal-first'), await create('equal-second')]
  const timestamp = '2099-10-09T12:34:56.789Z'
  expect(
    succeeds(
      'postgres',
      'postgres',
      `UPDATE doc SET updated_at='${timestamp}'::timestamptz WHERE id IN ('${ids[0]}','${ids[1]}');
       SELECT count(*) FROM doc WHERE id IN ('${ids[0]}','${ids[1]}') AND updated_at='${timestamp}'::timestamptz;`,
    ),
  ).toBe('2')

  const pulled: Array<{ id: string; updatedAt: string }> = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({
      scope: 'machine',
      updatedSince: '2098-01-01T00:00:00.000Z',
      includeDeleted: 'true',
      limit: '1',
    })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`${origin}/v1/docs?${query}`, { headers })
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      items: Array<{ id: string; updatedAt: string }>
      nextCursor: string | null
    }
    pulled.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)

  expect(pulled.map(({ id }) => id).sort()).toEqual(ids.sort())
  expect(pulled.map(({ updatedAt }) => updatedAt)).toEqual([timestamp, timestamp])
  const finalCursor = encodeURIComponent(
    btoa(JSON.stringify({ at: pulled.at(-1)!.updatedAt, id: pulled.at(-1)!.id })),
  )
  const final = await fetch(
    `${origin}/v1/docs?scope=machine&updatedSince=2098-01-01T00%3A00%3A00.000Z&includeDeleted=true&limit=1&cursor=${finalCursor}`,
    { headers },
  )
  expect(final.status).toBe(200)
  expect(((await final.json()) as { items: unknown[] }).items).toEqual([])
}
