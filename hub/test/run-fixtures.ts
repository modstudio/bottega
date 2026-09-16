import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'
import { db } from '../src/db.ts'
import { ingestRuns } from '../src/ingest/runs.ts'
import { MIGRATIONS_TABLE } from '../src/migrations.ts'
import { clearOrchCache } from '../src/serve.ts'

export const at = (iso: string) => new Date(iso).getTime()

export function resetFixtureStore() {
  const database = new Database(process.env.HUB_DB!)
  try {
    database.exec('PRAGMA query_only = OFF; PRAGMA foreign_keys = OFF')
    const tables = database
      .query<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name <> ? AND name NOT LIKE 'sqlite_%'`,
      )
      .all(MIGRATIONS_TABLE)
    for (const { name } of tables) database.exec(`DELETE FROM "${name}"`)
    const sequence = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'")
      .get()
    if (sequence) database.exec('DELETE FROM sqlite_sequence')
    database.exec('PRAGMA foreign_keys = ON')
  } finally {
    database.close()
  }
  clearOrchCache()
}

export const runFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  started_at: '2026-09-03T00:00:00.000Z',
  agent: 'grok',
  job: 'implement',
  repo: 'alpha',
  cwd: '/fixtures/repos/alpha/.claude/worktrees/ALP-118',
  session_id: null,
  latency_ms: null,
  vendor_tokens: null,
  vendor_cost_usd: null,
  prompt_head: 'Implement ALP-118',
  prompt_path: null,
  branch: 'ALP-118',
  probe: 0,
  status: 'running',
  delivery: null,
  quality: null,
  questions: [],
  ...overrides,
})

export async function ingestStdout(stdout: string) {
  const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
    stdout: new Blob([stdout]),
    stderr: new Blob(['']),
    exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn)
  try {
    return await ingestRuns('2026-09-01T00:00:00.000Z')
  } finally {
    spawn.mockRestore()
  }
}

export async function ingestRunFixtures(...runs: ReturnType<typeof runFixture>[]) {
  return await ingestStdout(runs.map((run) => JSON.stringify(run)).join('\n'))
}

export function collectRunsAt() {
  return (
    db()
      .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'collect.runs.at'`)
      .get()?.value ?? null
  )
}
