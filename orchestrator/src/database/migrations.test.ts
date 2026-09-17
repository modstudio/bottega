import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'

test('a fresh database seeds discoverable agents without machine probe claims', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    const rows = database
      .query('SELECT name, caps, probed_at, probe_result FROM agent ORDER BY name')
      .all() as {
      name: string
      caps: string
      probed_at: string | null
      probe_result: string | null
    }[]

    expect(rows.map((row) => row.name)).toEqual(['agy', 'codex', 'grok', 'qwen-local'])
    expect(rows.every((row) => row.probed_at === null && row.probe_result === null)).toBe(true)
    expect(rows.every((row) => Object.hasOwn(JSON.parse(row.caps), 'readsRepo'))).toBe(true)
  } finally {
    database.close()
  }
})
