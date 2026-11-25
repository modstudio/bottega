import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { installRecordPool } from '../../test/fixtures/record-pool-injection.ts'
import { releaseHostedBoardSessionClaims } from './record-board-claims.ts'

const spaceId = '01990000-0000-7000-8000-000000026421'
const userId = '01990000-0000-7000-8000-000000026422'
const otherUserId = '01990000-0000-7000-8000-000000026423'
const projectId = '01990000-0000-7000-8000-000000026424'
const fixtureUrl = 'postgres://board-claim-session.test/record'
const holderSession = 'session-to-release'

const claimIds = {
  callerLive: '01990000-0000-7000-8000-000000026425',
  callerLapsed: '01990000-0000-7000-8000-000000026426',
  anotherSession: '01990000-0000-7000-8000-000000026427',
  anotherUser: '01990000-0000-7000-8000-000000026428',
} as const

let database: PGlite
let restorePool: (() => void) | undefined
type CapturedQuery = { statement: string; parameters: unknown[] }
const capturedQueries: CapturedQuery[] = []
type ExplainNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  Filter?: string
  Plans?: ExplainNode[]
}

function capturingSql(base: SQL): SQL {
  return new Proxy(base, {
    apply(target, thisArg, args: Parameters<SQL>) {
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
        return <T>(work: (tx: SQL) => Promise<T>) => target.begin((tx) => work(capturingSql(tx)))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${otherUserId}','other@example.test','Other user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000026429','${spaceId}','${otherUserId}','member','write',now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','claim-session',ARRAY['DEV'],now());
    INSERT INTO board_claim
      (id,project_id,subject_kind,subject_value,holder_user_id,holder_session,duration_ms,
       taken_at,renewed_at,lapses_at)
    VALUES
      ('${claimIds.callerLive}','${projectId}','resource','caller-live','${userId}',
       '${holderSession}',60000,now(),now(),now() + interval '1 hour'),
      ('${claimIds.callerLapsed}','${projectId}','resource','caller-lapsed','${userId}',
       '${holderSession}',60000,now() - interval '2 hours',now() - interval '2 hours',
       now() - interval '1 hour'),
      ('${claimIds.anotherSession}','${projectId}','resource','another-session','${userId}',
       'another-session',60000,now(),now(),now() + interval '1 hour'),
      ('${claimIds.anotherUser}','${projectId}','resource','another-user','${otherUserId}',
       '${holderSession}',60000,now(),now(),now() + interval '1 hour');
    SET ROLE record_actor;
    SET enable_seqscan=off;
  `)
  restorePool = installRecordPool(fixtureUrl, capturingSql(pgliteSql(database)))
})

afterAll(async () => {
  restorePool?.()
  if (database) await database.close()
})

test('session release closes only the caller live claims held by that session', async () => {
  await expect(
    releaseHostedBoardSessionClaims({
      url: fixtureUrl,
      userId,
      spaceId,
      holderSession,
    }),
  ).resolves.toEqual({ released: 1 })

  const result = await database.query<{
    id: string
    closed_at: Date | null
    close_reason: string | null
  }>(`SELECT id, closed_at, close_reason FROM board_claim ORDER BY id`)
  expect(result.rows).toEqual([
    { id: claimIds.callerLive, closed_at: expect.any(Date), close_reason: 'released' },
    { id: claimIds.callerLapsed, closed_at: null, close_reason: null },
    { id: claimIds.anotherSession, closed_at: null, close_reason: null },
    { id: claimIds.anotherUser, closed_at: null, close_reason: null },
  ])

  const selection = capturedQueries.find(
    ({ statement }) =>
      statement.includes('FROM board_claim claim') && statement.includes('holder_session='),
  )
  const update = capturedQueries.find(({ statement }) => statement.includes('UPDATE board_claim'))
  expect(selection, 'captured production release-session selection').toBeDefined()
  expect(update, 'captured production release-session update').toBeDefined()

  const explain = async (query: CapturedQuery): Promise<ExplainNode> => {
    const result = await database.query<{ 'QUERY PLAN': Array<{ Plan: ExplainNode }> }>(
      `EXPLAIN (COSTS OFF, FORMAT JSON) ${query.statement}`,
      query.parameters,
    )
    return result.rows[0]!['QUERY PLAN'][0]!.Plan
  }
  const planNodes = (plan: ExplainNode): ExplainNode[] => [
    plan,
    ...(plan.Plans ?? []).flatMap(planNodes),
  ]
  const selectionScan = planNodes(await explain(selection!)).find(
    (node) => node['Relation Name'] === 'board_claim',
  )
  expect(selectionScan?.['Index Name']).toBe('board_claim_holder_session_open_idx')
  expect(selectionScan?.['Index Cond']).toContain('holder_user_id')
  expect(selectionScan?.['Index Cond']).toContain('holder_session')

  const updatePlan = await explain(update!)
  const updateNodes = planNodes(updatePlan)
  const updateScan = updateNodes.find(
    (node) =>
      node['Relation Name'] === 'board_claim' &&
      node['Index Name'] === 'board_claim_live_subject_unique',
  )
  expect(updateScan?.Filter).toContain('closed_at IS NULL')
  expect(updateScan?.Filter).toContain('id =')
  const updateWriteMembership = updateNodes.find(
    (node) => node['Relation Name'] === 'membership' && node.Filter?.includes("permission = 'write'"),
  )
  expect(updateWriteMembership).toBeDefined()

  await database.exec(`
    RESET ROLE;
    UPDATE membership SET permission='read'
    WHERE space_id='${spaceId}' AND user_id='${otherUserId}';
    SET ROLE record_actor;
  `)
  await expect(
    releaseHostedBoardSessionClaims({
      url: fixtureUrl,
      userId: otherUserId,
      spaceId,
      holderSession,
    }),
  ).resolves.toEqual({ released: 0 })
  const readOnlyClaim = await database.query<{ closed_at: Date | null }>(
    `SELECT closed_at FROM board_claim WHERE id='${claimIds.anotherUser}'`,
  )
  expect(readOnlyClaim.rows).toEqual([{ closed_at: null }])
})
