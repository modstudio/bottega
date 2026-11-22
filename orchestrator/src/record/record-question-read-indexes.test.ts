import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture } from '../../test/fixtures/hosted-record.ts'
import { readRecordQuestionRows } from './record-question-read.ts'

const spaceId = '01990000-0000-7000-8000-000000006001'
const userId = '01990000-0000-7000-8000-000000006002'
const lookupId = '01990000-0000-7000-8000-000000006003'
const secondSpaceId = '01990000-0000-7000-8000-000000006004'

type QuestionReadInput = Parameters<typeof readRecordQuestionRows>[1]
type CapturedQuery = { statement: string; parameters: unknown[] }
type ExplainNode = {
  'Node Type': string
  'Parent Relationship'?: string
  'Relation Name'?: string
  Alias?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  Plans?: ExplainNode[]
}

let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${secondSpaceId}','Second mirror test','second-mirror-test',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000006005','${secondSpaceId}','${userId}','member','write',now());
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId},${secondSpaceId}',false);
    SET enable_seqscan=off;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('hot hosted record predicates are applied as index conditions', async () => {
  const lookups = [
    { table: 'question', column: 'run_id' },
    { table: 'question', column: 'workflow_cursor_record_id' },
    { table: 'run', column: 'parent_run_id' },
  ] as const

  for (const { table, column } of lookups) {
    const result = await database.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) SELECT id FROM "${table}" WHERE "${column}"=$1`,
      [lookupId],
    )
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
    expect(plan).toMatch(new RegExp(`Index Cond: .*${column}`))
  }
})

async function captureQueries(input: QuestionReadInput): Promise<CapturedQuery[]> {
  const queries: CapturedQuery[] = []
  const unsafe = (statement: string, parameters: unknown[] = []) => {
    queries.push({ statement, parameters })
    return Promise.resolve(statement.includes('SELECT COUNT(*) count') ? [{ count: 0 }] : [])
  }
  await readRecordQuestionRows({ unsafe } as unknown as SQL, input)
  return queries
}

type TenantScan = { node: ExplainNode; outermost: boolean }

function tenantTableScans(plan: ExplainNode, outermost = true): TenantScan[] {
  const scans =
    plan['Relation Name'] === 'run' || plan['Relation Name'] === 'question'
      ? [{ node: plan, outermost }]
      : []
  for (const [index, child] of (plan.Plans ?? []).entries()) {
    scans.push(
      ...tenantTableScans(
        child,
        outermost && index === 0 && child['Parent Relationship'] !== 'SubPlan',
      ),
    )
  }
  return scans
}

async function explain(statement: string, parameters: unknown[]): Promise<ExplainNode> {
  const result = await database.query<{ 'QUERY PLAN': Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (COSTS OFF, FORMAT JSON) ${statement}`,
    parameters,
  )
  return result.rows[0]!['QUERY PLAN'][0]!.Plan
}

test('hosted question reads use tenant-table key indexes under RLS', async () => {
  const cases: Array<{
    name: string
    input: QuestionReadInput
    query: number
    driver?: { relation: string; alias: string }
  }> = [
    { name: 'for-runs detail', input: { read: 'for-runs', runIds: [lookupId] }, query: 0 },
    {
      name: 'membership inbox',
      input: { read: 'inbox' },
      query: 1,
      driver: { relation: 'question', alias: 'q' },
    },
    {
      name: 'membership open-for-tasks',
      input: { read: 'open-for-tasks', taskRecordIds: [lookupId] },
      query: 0,
    },
    {
      name: 'open-for-cursors',
      input: { read: 'open-for-cursors', workflowCursorRecordIds: [lookupId] },
      query: 0,
    },
  ]

  for (const { name, input, query, driver } of cases) {
    const captured = await captureQueries(input)
    const selected = captured[query]
    expect(selected, `${name} SQL query`).toBeDefined()
    const plan = await explain(selected!.statement, selected!.parameters)
    const scans = tenantTableScans(plan)
    expect(scans.length, `${name} tenant-table scans`).toBeGreaterThan(0)
    let driverScans = 0
    for (const { node: scan, outermost } of scans) {
      const condition = scan['Index Cond'] ?? scan['Recheck Cond']
      const label = `${name}: ${scan['Node Type']} on ${scan['Relation Name']} ${scan.Alias ?? ''}`
      expect(condition, label).toBeDefined()
      if (
        condition?.match(
          /\b(?:id|parent_run_id|run_id|workflow_cursor_record_id|workflow_task_id)\b/,
        )
      )
        continue
      expect(driver, `${label} has only a tenant-space condition`).toBeDefined()
      expect({ relation: scan['Relation Name'], alias: scan.Alias }, label).toEqual(driver!)
      expect(outermost, `${label} must be the statement's outermost tenant scan`).toBe(true)
      expect(condition, label).toContain('space_id')
      driverScans += 1
    }
    expect(driverScans, `${name} declared driver scans`).toBe(driver ? 1 : 0)
  }
})
