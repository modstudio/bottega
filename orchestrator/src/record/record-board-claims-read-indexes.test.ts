import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { installRecordPool } from '../../test/fixtures/record-pool-injection.ts'
import { listHostedBoardClaims } from './record-board-claims.ts'

const spaceId = '01990000-0000-7000-8000-000000025401'
const userId = '01990000-0000-7000-8000-000000025402'
const projectId = '01990000-0000-7000-8000-000000025403'
const openId = '01990000-0000-7000-8000-000000025404'
const secondOpenId = '01990000-0000-7000-8000-000000025405'
const lapsedId = '01990000-0000-7000-8000-000000025406'
const firstPreviousId = '01990000-0000-7000-8000-000000025407'
const secondPreviousId = '01990000-0000-7000-8000-000000025408'
const fixtureUrl = 'postgres://board-claim-read-indexes.test/record'

type ExplainNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  Plans?: ExplainNode[]
}

let database: PGlite
let restorePool: (() => void) | undefined
let statementCount = 0
type CapturedQuery = { statement: string; parameters: unknown[] }
let capturedQueries: CapturedQuery[] = []

function countedSql(base: SQL): SQL {
  return new Proxy(base, {
    apply(target, thisArg, args: Parameters<SQL>) {
      statementCount += 1
      const result = Reflect.apply(target, thisArg, args)
      if (
        typeof result === 'object' &&
        result !== null &&
        'sql' in result &&
        'parameters' in result
      ) {
        capturedQueries.push({
          statement: String(result.sql),
          parameters: [...(result.parameters as unknown[])],
        })
      }
      return result
    },
    get(target, property, receiver) {
      if (property === 'begin') {
        return <T>(work: (tx: SQL) => Promise<T>) => target.begin((tx) => work(countedSql(tx)))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function claimId(number: number): string {
  return `01990000-0000-7000-8000-${String(number).padStart(12, '0')}`
}

function claimValues(
  id: string,
  subject: string,
  takenAt: string,
  lapsesAt: string,
  closedAt: string | null,
  supersededBy: string | null = null,
): string {
  const closed = closedAt ? `'${closedAt}','taken-over'` : 'NULL,NULL'
  const superseded = supersededBy ? `'${supersededBy}'` : 'NULL'
  return `('${id}','${projectId}','resource','${subject}','${userId}',60000,
    '${takenAt}','${takenAt}','${lapsesAt}',${closed},${superseded})`
}

async function seedClosedClaims(start: number, count: number, supersededBy: string): Promise<void> {
  const values = Array.from({ length: count }, (_, offset) => {
    const minute = String((offset % 50) + 1).padStart(2, '0')
    return claimValues(
      claimId(start + offset),
      `closed-${start + offset}`,
      `2026-11-20T10:${minute}:00Z`,
      '2026-11-20T11:00:00Z',
      '2026-11-20T12:00:00Z',
      supersededBy,
    )
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO board_claim
      (id,project_id,subject_kind,subject_value,holder_user_id,duration_ms,taken_at,renewed_at,
       lapses_at,closed_at,close_reason,superseded_by_claim_id)
    VALUES ${values.join(',')};
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SET enable_seqscan=off;
  `)
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','claim-read-indexes',ARRAY['DEV'],now());
    INSERT INTO board_claim
      (id,project_id,subject_kind,subject_value,holder_user_id,duration_ms,taken_at,renewed_at,
       lapses_at,closed_at,close_reason,superseded_by_claim_id)
    VALUES
      ${claimValues(firstPreviousId, 'first-previous', '2026-11-20T08:00:00Z', '2026-11-20T09:00:00Z', '2026-11-20T09:30:00Z', openId)},
      ${claimValues(secondPreviousId, 'second-previous', '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z', '2026-11-20T10:30:00Z', openId)},
      ${claimValues(openId, 'open', '2026-11-21T08:00:00Z', '2099-11-21T09:00:00Z', null)},
      ${claimValues(secondOpenId, 'second-open', '2026-11-21T09:00:00Z', '2099-11-21T10:00:00Z', null)},
      ${claimValues(lapsedId, 'lapsed', '2026-11-21T10:00:00Z', '2026-11-21T11:00:00Z', null)};
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SET enable_seqscan=off;
  `)
  await seedClosedClaims(25500, 12, openId)
  restorePool = installRecordPool(fixtureUrl, countedSql(pgliteSql(database)))
})

afterAll(async () => {
  restorePool?.()
  if (database) await database.close()
})

function planNodes(plan: ExplainNode): ExplainNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]
}

async function explain(statement: string, parameters: unknown[]): Promise<ExplainNode> {
  const result = await database.query<{ 'QUERY PLAN': Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (COSTS OFF, FORMAT JSON) ${statement}`,
    parameters,
  )
  return result.rows[0]!['QUERY PLAN'][0]!.Plan
}

function expectBoardClaimIndexCondition(plan: ExplainNode, column: string): void {
  const scans = planNodes(plan).filter(
    (node) =>
      node['Relation Name'] === 'board_claim' || node['Index Name']?.startsWith('board_claim_'),
  )
  expect(scans.length, 'board_claim plan nodes').toBeGreaterThan(0)
  expect(
    scans.some((scan) => (scan['Index Cond'] ?? scan['Recheck Cond'])?.includes(column)),
    JSON.stringify(plan),
  ).toBe(true)
  for (const scan of scans) {
    const condition = scan['Index Cond'] ?? scan['Recheck Cond']
    if (condition) expect(condition, JSON.stringify(scan)).not.toMatch(/^\(space_id = /)
  }
}

test('open and predecessor reads use board_claim index conditions under RLS', async () => {
  capturedQueries = []
  await listHostedBoardClaims({
    url: fixtureUrl,
    userId,
    spaceId,
    project: 'claim-read-indexes',
    projectId,
    openOnly: true,
  })
  const openQuery = capturedQueries.find(
    ({ statement }) =>
      statement.includes('SELECT * FROM board_claim') && statement.includes('project_id='),
  )
  const previousQuery = capturedQueries.find(({ statement }) =>
    statement.includes('WHERE superseded_by_claim_id = ANY('),
  )
  expect(openQuery, 'captured production open-only list query').toBeDefined()
  expect(previousQuery, 'captured production predecessor query').toBeDefined()
  const open = await explain(openQuery!.statement, openQuery!.parameters)
  const previous = await explain(previousQuery!.statement, previousQuery!.parameters)
  expectBoardClaimIndexCondition(open, 'project_id')
  expectBoardClaimIndexCondition(previous, 'superseded_by_claim_id')
})

async function listedWithStatementCount() {
  statementCount = 0
  const result = await listHostedBoardClaims({
    url: fixtureUrl,
    userId,
    spaceId,
    project: 'claim-read-indexes',
    projectId,
    openOnly: true,
  })
  return { result, statements: statementCount }
}

test('open-only list keeps lapsed claims, predecessors, and a constant statement count', async () => {
  const first = await listedWithStatementCount()
  expect(first.result.claims.map((claim) => claim.id)).toEqual([openId, secondOpenId, lapsedId])
  expect(first.result.claims.find((claim) => claim.id === lapsedId)).toMatchObject({
    live: false,
    closedAt: null,
  })
  expect(first.result.claims.find((claim) => claim.id === openId)?.previousClaimIds).toEqual([
    firstPreviousId,
    secondPreviousId,
    ...Array.from({ length: 12 }, (_, offset) => claimId(25500 + offset)),
  ])
  expect(first.statements).toBe(6)

  await seedClosedClaims(25600, 48, secondOpenId)
  const second = await listedWithStatementCount()
  expect(second.result.claims.map((claim) => claim.id)).toEqual([openId, secondOpenId, lapsedId])
  expect(second.statements).toBe(first.statements)
})
