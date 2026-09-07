import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { db } from '../src/db.ts'

test('the preload clears every persistent table except schema metadata', () => {
  const persistent = db().query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name",
  ).all().map(({ name }) => name)
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const cleared = [...preload.matchAll(/DELETE FROM ([a-z_]+)/g)].map((match) => match[1]!).sort()

  expect(cleared).toEqual(persistent)
})
