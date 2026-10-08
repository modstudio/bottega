import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { canonFacts } from './record-canon-facts.ts'

test('hosted canon facts compose current rows and ignore non-current rows', async () => {
  const queries: string[] = []
  const tx = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    queries.push(query)
    const rows = [
      { slug: 'current', body: 'current body', status: 'current' },
      { slug: 'draft', body: 'draft body', status: 'draft' },
    ]
    return query.includes("status='current'")
      ? rows.filter((row) => row.status === 'current')
      : rows
  }) as unknown as SQL

  const facts = await canonFacts(
    tx,
    '00000000-0000-0000-0000-000000000001',
    'canon',
    null,
    'changed',
    'changed body',
  )

  expect(queries).toHaveLength(1)
  expect(facts.currentCanon).toEqual([{ slug: 'current', body: 'current body' }])
  expect(facts.nextCanon).toEqual([
    { slug: 'current', body: 'current body' },
    { slug: 'changed', body: 'changed body' },
  ])
})
