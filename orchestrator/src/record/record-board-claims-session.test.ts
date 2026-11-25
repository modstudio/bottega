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
const secondSpaceId = '01990000-0000-7000-8000-000000026430'
const secondProjectId = '01990000-0000-7000-8000-000000026431'
const fixtureUrl = 'postgres://board-claim-session.test/record'
const holderSession = 'session-to-release'
const cursorIds = {
  machine: '01990000-0000-7000-8000-000000026434',
  flow: '01990000-0000-7000-8000-000000026435',
  stage: '01990000-0000-7000-8000-000000026436',
  workflow: '01990000-0000-7000-8000-000000026437',
  workflowVersion: '01990000-0000-7000-8000-000000026438',
  catalogue: '01990000-0000-7000-8000-000000026439',
  catalogueVersion: '01990000-0000-7000-8000-000000026440',
} as const

const claimIds = {
  callerLive: '01990000-0000-7000-8000-000000026425',
  callerLapsed: '01990000-0000-7000-8000-000000026426',
  anotherSession: '01990000-0000-7000-8000-000000026427',
  anotherUser: '01990000-0000-7000-8000-000000026428',
  crossSpace: '01990000-0000-7000-8000-000000026432',
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
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${secondSpaceId}','Second space','second-space',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000026433','${secondSpaceId}','${userId}','member','write',now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES
      ('${projectId}','${spaceId}','claim-session',ARRAY['DEV'],now()),
      ('${secondProjectId}','${secondSpaceId}','claim-session-second',ARRAY['SECOND'],now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${cursorIds.machine}','${userId}','Claim session machine',now(),now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${cursorIds.workflow}','${spaceId}','claim-session',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${cursorIds.workflowVersion}','${spaceId}','${cursorIds.workflow}',1,'production','{}',
      'test','claim session',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${cursorIds.catalogue}','${spaceId}','claim-session',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${cursorIds.catalogueVersion}','${spaceId}','${cursorIds.catalogue}',1,'production','{}',
      'test','claim session',now(),now());
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${cursorIds.flow}','${spaceId}','${projectId}','open','${cursorIds.machine}',
      '${cursorIds.machine}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,enforcement,total_steps,opened_machine_id,last_advanced_machine_id,
       revision,created_at,updated_at)
    VALUES ('${cursorIds.stage}','${spaceId}','${cursorIds.flow}','${projectId}',1,
      'claim-session','default','DEV-CURSOR','${holderSession}','${cursorIds.workflowVersion}',
      '${cursorIds.catalogueVersion}','{}',0,'implementation','running','[]','signed',1,
      '${cursorIds.machine}','${cursorIds.machine}',1,now(),now());
    UPDATE task_flow SET open_stage_record_id='${cursorIds.stage}' WHERE id='${cursorIds.flow}';
    INSERT INTO board_claim
      (id,project_id,subject_kind,subject_value,holder_user_id,holder_session,duration_ms,
       taken_at,renewed_at,lapses_at)
    VALUES
      ('${claimIds.callerLive}','${projectId}','resource','caller-live','${userId}',
       '${holderSession}',60000,now(),now(),now() + interval '1 hour'),
      ('${claimIds.callerLapsed}','${projectId}','task','DEV-CURSOR','${userId}',
       '${holderSession}',60000,now() - interval '2 hours',now() - interval '2 hours',
       now() - interval '1 hour'),
      ('${claimIds.anotherSession}','${projectId}','resource','another-session','${userId}',
       'another-session',60000,now(),now(),now() + interval '1 hour'),
      ('${claimIds.anotherUser}','${projectId}','resource','another-user','${otherUserId}',
       '${holderSession}',60000,now(),now(),now() + interval '1 hour'),
      ('${claimIds.crossSpace}','${secondProjectId}','resource','cross-space','${userId}',
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
      spaceIds: [spaceId, secondSpaceId],
      holderSession,
    }),
  ).resolves.toEqual({ released: 3 })

  await database.exec('RESET ROLE')
  const result = await database.query<{
    id: string
    closed_at: Date | null
    close_reason: string | null
  }>(`SELECT id, closed_at, close_reason FROM board_claim ORDER BY id`)
  expect(result.rows).toEqual([
    { id: claimIds.callerLive, closed_at: expect.any(Date), close_reason: 'released' },
    { id: claimIds.callerLapsed, closed_at: expect.any(Date), close_reason: 'released' },
    { id: claimIds.anotherSession, closed_at: null, close_reason: null },
    { id: claimIds.anotherUser, closed_at: null, close_reason: null },
    { id: claimIds.crossSpace, closed_at: expect.any(Date), close_reason: 'released' },
  ])
  await database.exec(`
    SET ROLE record_actor;
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId},${secondSpaceId}',false);
  `)

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
    (node) => node['Relation Name'] === 'board_claim' && node['Index Name'],
  )
  const updatePredicates = `${updateScan?.['Index Cond'] ?? ''} ${updateScan?.Filter ?? ''}`
  expect(updatePredicates).toContain('id =')
  expect(updatePredicates).toContain('closed_at IS NULL')
  const updateWriteMembership = updateNodes.find(
    (node) =>
      node['Relation Name'] === 'membership' && node.Filter?.includes("permission = 'write'"),
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
