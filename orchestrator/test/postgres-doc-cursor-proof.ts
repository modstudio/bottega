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
  const cursorTimes = ['2099-10-09T12:34:56.789123Z', '2099-10-09T12:34:56.789456Z']
  expect(
    succeeds(
      'postgres',
      'postgres',
      `UPDATE doc SET updated_at=CASE id
         WHEN '${ids[0]}'::uuid THEN '${cursorTimes[0]}'::timestamptz
         ELSE '${cursorTimes[1]}'::timestamptz END
       WHERE id IN ('${ids[0]}','${ids[1]}');
       SELECT count(*) FROM doc WHERE id IN ('${ids[0]}','${ids[1]}')
         AND date_trunc('milliseconds', updated_at)='2099-10-09T12:34:56.789Z'::timestamptz;`,
    ),
  ).toBe('2')
  const plan = succeeds(
    'postgres',
    'postgres',
    `SET enable_seqscan=off;
     EXPLAIN (COSTS OFF)
     SELECT id FROM doc
     WHERE space_id=(SELECT space_id FROM doc WHERE id='${ids[0]}')
       AND (updated_at,id) > ('2098-01-01T00:00:00Z'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY updated_at,id LIMIT 2;`,
  )
  expect(plan).toContain('doc_updated_at')

  const pulled: Array<{ id: string; updatedAt: string }> = []
  let cursor: string | null = null
  let endCursor: string | null = null
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
      endCursor: string | null
    }
    pulled.push(...page.items)
    endCursor = page.endCursor
    cursor = page.nextCursor
  } while (cursor)

  expect(pulled.map(({ id }) => id).sort()).toEqual(ids.sort())
  expect(pulled.map(({ updatedAt }) => updatedAt)).toEqual([
    '2099-10-09T12:34:56.789Z',
    '2099-10-09T12:34:56.789Z',
  ])
  expect(endCursor).not.toBeNull()
  expect(JSON.parse(atob(endCursor!))).toEqual({ at: cursorTimes[1], id: ids[1] })
  const final = await fetch(
    `${origin}/v1/docs?scope=machine&updatedSince=2098-01-01T00%3A00%3A00.000Z&includeDeleted=true&limit=1&cursor=${encodeURIComponent(endCursor!)}`,
    { headers },
  )
  expect(final.status).toBe(200)
  expect(((await final.json()) as { items: unknown[] }).items).toEqual([])
}
