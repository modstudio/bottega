import { expect } from 'bun:test'
import { succeeds } from './fixtures/postgres-rls.ts'

type ProofSubject = {
  id: string
  name: string
  definition: string
  state: 'active' | 'retired'
  updatedAt: string
}

export async function proveSubjects(
  origin: string,
  headers: Record<string, string>,
  project: string,
): Promise<void> {
  const add = async (name: string, definition: string) => {
    const response = await fetch(`${origin}/v1/subjects`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project, name, definition }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ProofSubject
  }
  const first = await add('First', '  The first subject. \n')
  expect(first.definition).toBe('The first subject.')
  const second = await add('Second', 'The second subject.')
  const third = await add('Third', 'The third subject.')
  const list = async (query = '') => {
    const response = await fetch(
      `${origin}/v1/subjects?project=${encodeURIComponent(project)}${query}`,
      { headers },
    )
    expect(response.status).toBe(200)
    return (await response.json()) as {
      items: ProofSubject[]
      nextCursor: string | null
      endCursor: string | null
    }
  }
  expect((await list()).items.map(({ name }) => name)).toEqual(['First', 'Second', 'Third'])

  const renamed = await fetch(`${origin}/v1/subjects/${second.id}/rename`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project, name: 'Renamed' }),
  })
  expect(renamed.status).toBe(200)
  expect((await renamed.json()) as ProofSubject).toMatchObject({ id: second.id, name: 'Renamed' })

  const defined = await fetch(`${origin}/v1/subjects/${third.id}/define`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project, definition: '\tThe updated third subject.\r' }),
  })
  expect(defined.status).toBe(200)
  expect((await defined.json()) as ProofSubject).toMatchObject({
    id: third.id,
    definition: 'The updated third subject.',
  })

  const multiline = await fetch(`${origin}/v1/subjects/${third.id}/define`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project, definition: 'First line\nSecond line' }),
  })
  expect(multiline.status).toBe(400)
  expect(await multiline.json()).toEqual({
    error: 'a subject definition must be one non-empty line',
  })

  const duplicate = await fetch(`${origin}/v1/subjects`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ project, name: 'First', definition: 'Duplicate live name.' }),
  })
  expect(duplicate.status).toBe(409)

  const reordered = await fetch(`${origin}/v1/subjects/reorder`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project, ids: [third.id, first.id, second.id] }),
  })
  expect(reordered.status).toBe(200)
  expect(((await reordered.json()) as { items: ProofSubject[] }).items.map(({ id }) => id)).toEqual(
    [third.id, first.id, second.id],
  )

  const retired = await fetch(`${origin}/v1/subjects/${first.id}/retire`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project }),
  })
  expect(retired.status).toBe(200)
  expect((await retired.json()) as ProofSubject).toMatchObject({ id: first.id, state: 'retired' })
  expect((await list()).items.map(({ id }) => id)).toEqual([third.id, second.id])
  expect((await list('&includeRetired=true')).items.map(({ id }) => id)).toEqual([
    third.id,
    first.id,
    second.id,
  ])

  const cursorTimes = [
    '2099-10-09T12:34:56.789123Z',
    '2099-10-09T12:34:56.789456Z',
    '2099-10-09T12:34:56.789789Z',
  ]
  expect(
    succeeds(
      'postgres',
      'postgres',
      `UPDATE subject SET updated_at=CASE id
        WHEN '${first.id}'::uuid THEN '${cursorTimes[0]}'::timestamptz
        WHEN '${second.id}'::uuid THEN '${cursorTimes[1]}'::timestamptz
        ELSE '${cursorTimes[2]}'::timestamptz END
       WHERE id IN ('${first.id}','${second.id}','${third.id}');
       SELECT count(*) FROM subject WHERE id IN ('${first.id}','${second.id}','${third.id}')
         AND date_trunc('milliseconds', updated_at)='2099-10-09T12:34:56.789Z'::timestamptz;`,
    ),
  ).toBe('3')

  const paged: ProofSubject[] = []
  let cursor: string | null = null
  let endCursor: string | null = null
  do {
    const suffix = `&includeRetired=true&order=updated&limit=1${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    }`
    const page = await list(suffix)
    expect(page.items).toHaveLength(1)
    paged.push(page.items[0]!)
    endCursor = page.endCursor
    cursor = page.nextCursor
  } while (cursor)
  expect(new Set(paged.map(({ id }) => id))).toEqual(new Set([first.id, second.id, third.id]))
  expect(paged).toHaveLength(3)
  expect(paged.map(({ updatedAt }) => updatedAt)).toEqual([
    '2099-10-09T12:34:56.789Z',
    '2099-10-09T12:34:56.789Z',
    '2099-10-09T12:34:56.789Z',
  ])

  const final = paged.at(-1)!
  expect(JSON.parse(atob(endCursor!))).toEqual({ at: cursorTimes[2], id: final.id })
  expect(
    (
      await list(
        `&includeRetired=true&order=updated&limit=1&cursor=${encodeURIComponent(endCursor!)}`,
      )
    ).items,
  ).toEqual([])
}
