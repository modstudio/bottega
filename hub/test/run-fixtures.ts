import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'
import type { OrchRun } from '../../shared/orch-contract.ts'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'
import { refreshKeyPrefixes } from '../src/attribute.ts'
import { db } from '../src/db.ts'
import { ingestRuns } from '../src/ingest/runs.ts'
import { MIGRATIONS_TABLE } from '../src/migrations.ts'
import { clearOrchCache } from '../src/serve.ts'

export const at = (iso: string) => new Date(iso).getTime()
export const fixtureRecordId = (id: number) =>
  `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`

export function resetFixtureStore(assertSafe?: () => void) {
  refreshKeyPrefixes()
  const guard = assertSafe ?? createTestHubDatabaseGuard()
  guard()
  const database = new Database(process.env.BOTTEGA_HUB_DB!)
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

export const questionFixture = (overrides: Record<string, unknown> = {}) => {
  const id = Number(overrides.id ?? 1)
  const runNumber = Number(overrides.run_number ?? overrides.run_id ?? 9001)
  const { run_id: _legacyRunId, ...fields } = overrides
  return {
    id,
    record_id: fixtureRecordId(id),
    run_number: runNumber,
    run_record_id: fixtureRecordId(runNumber),
    asked_at: '2026-09-03T00:00:00.000Z',
    answered_at: null,
    asked_via: 'reply',
    answerer_kind: null,
    answer_channel: null,
    overturned_at: null,
    closed_at: null,
    close_reason: null,
    deliveries: [],
    ...fields,
  }
}

export const runFixture = (overrides: Record<string, unknown> = {}): OrchRun => {
  const number = Number(overrides.number ?? overrides.id ?? 9001)
  const { id: _id, number: _number, record_id: _recordId, ...fields } = overrides
  const fixture = {
    id: fixtureRecordId(number),
    number,
    record_id: fixtureRecordId(number),
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
    questions: [] as Record<string, unknown>[],
    ...fields,
  }
  if (Array.isArray(fixture.questions)) {
    fixture.questions = fixture.questions.map((question) => {
      const value = question as Record<string, unknown>
      const questionId = Number(value.id)
      const runNumber = Number(value.run_number ?? value.run_id)
      const { run_id: _legacyRunId, ...questionFields } = value
      return {
        record_id: fixtureRecordId(questionId),
        run_number: runNumber,
        run_record_id: fixtureRecordId(runNumber),
        asked_via: null,
        answerer_kind: null,
        answer_channel: null,
        overturned_at: null,
        closed_at: null,
        close_reason: null,
        ...questionFields,
        deliveries: Array.isArray(value.deliveries)
          ? value.deliveries.map((delivery) => {
              const item = delivery as Record<string, unknown>
              const deliveryRunNumber =
                (item.run_number ?? item.run_id) === null
                  ? null
                  : Number(item.run_number ?? item.run_id)
              const { run_id: _legacyDeliveryRunId, ...deliveryFields } = item
              return {
                question_record_id: fixtureRecordId(questionId),
                run_number: deliveryRunNumber,
                run_record_id:
                  deliveryRunNumber === null ? null : fixtureRecordId(deliveryRunNumber),
                ...deliveryFields,
              }
            })
          : [],
      }
    })
  }
  if (Array.isArray((fixture as Record<string, unknown>).turns)) {
    ;(fixture as Record<string, unknown>).turns = (
      (fixture as Record<string, unknown>).turns as Record<string, unknown>[]
    ).map((turn) => {
      const turnNumber = Number(turn.number ?? turn.id)
      return {
        ...turn,
        id: fixtureRecordId(turnNumber),
        number: turnNumber,
        record_id: fixtureRecordId(turnNumber),
      }
    })
  }
  if (typeof (fixture as Record<string, unknown>).retry_of === 'number') {
    ;(fixture as Record<string, unknown>).retry_record_id = fixtureRecordId(
      (fixture as Record<string, unknown>).retry_of as number,
    )
  }
  return fixture as unknown as OrchRun
}

export async function ingestStdout(stdout: string, rulings = '[]') {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => ({
    stdout: new Blob([args.includes('ruling') ? rulings : stdout]),
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

export function runHubFixtureProcess(
  args: string[],
  options: { env: Record<string, string | undefined>; cwd: string },
) {
  return Bun.spawnSync(args, options)
}

export function collectRunsAt() {
  return (
    db()
      .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'collect.runs.at'`)
      .get()?.value ?? null
  )
}
