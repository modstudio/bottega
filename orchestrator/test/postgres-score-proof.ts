import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import { pullRecordCache } from '../src/record/record-cache.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { listRecordScores, unvoidRecordRun, voidRecordRun } from '../src/record/record-verdicts.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from '../src/run/run-outbox.ts'
import { SCORE_RECORD_PAYLOAD_COLUMNS } from '../src/score/score-outbox.ts'
import { VOID_EXCLUSION_REASON } from '../src/verdict/verdict-rules.ts'
import { createMemoryRecordApiClient, installRecordApiClient } from './fixtures/record-api.ts'

export { proveHostedDocs } from './postgres-docs-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

export async function proveProjectSpaceRecordSync(input: {
  actorUrl: string
  actorRole: string
  machineId: string
  userId: string
  firstSpaceId: string
  secondSpaceId: string
  asSpace: (user: string, password: string, spaceId: string, statement: string) => PsqlResult
}): Promise<string[]> {
  const local = new Database(':memory:')
  applyMigrations(local)
  const ids = [newRecordId(), newRecordId()]
  for (const [index, projectName] of ['alpha', 'beta'].entries()) {
    const run = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
    Object.assign(run, {
      id: ids[index],
      spaceId: input.firstSpaceId,
      projectName,
      machineId: input.machineId,
      localId: 150 + index,
      startedAt: '2026-09-17T01:00:00.000Z',
      agent: 'codex',
      job: 'probe',
      promptSha: 'prompt',
      promptBytes: 6,
      promptHead: 'prompt',
      probe: true,
      status: 'ok',
      turn: 1,
      noFailover: false,
      automaticFailover: false,
      workPreserved: false,
      createdAt: '2026-09-17T01:00:00.000Z',
      updatedAt: '2026-09-17T01:00:00.000Z',
    })
    local
      .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (?,'run',?,?,?)")
      .run(index + 1, ids[index]!, JSON.stringify(run), String(run.createdAt))
  }
  expect(
    await syncRecord({
      recordUrl: input.actorUrl,
      local,
      identity: { id: input.machineId, name: 'proof-machine' },
      principal: { userId: input.userId, spaceId: input.firstSpaceId },
      memberships: [
        {
          spaceId: input.firstSpaceId,
          slug: 'alpha-space',
        },
        {
          spaceId: input.secondSpaceId,
          slug: 'beta-space',
        },
      ],
      projectSpaces: { alpha: 'alpha-space', beta: 'beta-space' },
    }),
  ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })
  const first = input.asSpace(
    input.actorRole,
    'actor-password',
    input.firstSpaceId,
    `SELECT id FROM run WHERE id IN ('${ids.join("','")}') ORDER BY id;`,
  )
  const second = input.asSpace(
    input.actorRole,
    'actor-password',
    input.secondSpaceId,
    `SELECT id FROM run WHERE id IN ('${ids.join("','")}') ORDER BY id;`,
  )
  expect(first.stdout).toBe(ids[0]!)
  expect(second.stdout).toBe(ids[1]!)
  local.close()
  return ids
}

export async function proveScoreRecordSync(input: {
  actorUrl: string
  ownerUrl: string
  actorRole: string
  ownerRole: string
  machineId: string
  userId: string
  spaceId: string
  otherSpaceId: string
  projectName: string
  asSpace: (user: string, password: string, spaceId: string, statement: string) => PsqlResult
}): Promise<{ actorRead: PsqlResult; otherSpaceRead: PsqlResult; rescoredRead: PsqlResult }> {
  const local = new Database(':memory:')
  applyMigrations(local)
  const run = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
  const recordId = newRecordId()
  Object.assign(run, {
    id: recordId,
    spaceId: input.spaceId,
    projectName: input.projectName,
    machineId: input.machineId,
    localId: 99,
    startedAt: '2026-09-15T01:00:00.000Z',
    finishedAt: '2026-09-15T01:01:00.000Z',
    agent: 'codex',
    job: 'probe',
    promptSha: 'prompt',
    promptBytes: 6,
    promptHead: 'prompt',
    probe: true,
    status: 'ok',
    turn: 1,
    noFailover: false,
    automaticFailover: false,
    workPreserved: false,
    createdAt: '2026-09-15T01:00:00.000Z',
    updatedAt: '2026-09-15T01:01:00.000Z',
  })
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (1,'run',?,?,?)")
    .run(recordId, JSON.stringify(run), String(run.createdAt))
  const sync = (recordUrl: string) =>
    syncRecord({
      recordUrl,
      local,
      identity: { id: input.machineId, name: 'proof-machine' },
      principal: { userId: input.userId, spaceId: input.spaceId },
    })
  expect(await sync(input.actorUrl)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })

  const score = Object.fromEntries(SCORE_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
  Object.assign(score, {
    id: recordId,
    spaceId: input.spaceId,
    projectName: input.projectName,
    machineId: input.machineId,
    localId: 99,
    delivery: 'full',
    quality: 'right',
    fidelity: null,
    note: 'first',
    scoredAt: '2026-09-15T01:02:00.000Z',
    scoredBy: 'architect',
    updatedAt: '2026-09-15T01:02:00.000Z',
  })
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (2,'score',?,?,?)")
    .run(recordId, JSON.stringify(score), String(score.scoredAt))
  expect(await sync(input.actorUrl)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  const select = (spaceId: string, expression: string) =>
    input.asSpace(
      input.actorRole,
      'actor-password',
      spaceId,
      `SELECT ${expression} FROM run_score WHERE run_id='${recordId}';`,
    )
  const actorRead = select(input.spaceId, "delivery || '|' || quality || '|' || note")
  const otherSpaceRead = select(input.otherSpaceId, 'run_id')

  const unscoredId = newRecordId()
  Object.assign(run, { id: unscoredId, localId: 100 })
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (3,'run',?,?,?)")
    .run(unscoredId, JSON.stringify(run), String(run.createdAt))
  expect(await sync(input.actorUrl)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  const tenant = { url: input.actorUrl, userId: input.userId, spaceId: input.spaceId }
  await voidRecordRun({ ...tenant, id: recordId, reason: VOID_EXCLUSION_REASON })
  await voidRecordRun({ ...tenant, id: unscoredId, reason: VOID_EXCLUSION_REASON })
  const voidRows = await listRecordScores({ ...tenant, limit: 100, cursor: null })
  const cursor = voidRows
    .filter((row) => row.runId === recordId || row.runId === unscoredId)
    .map((row) => row.updatedAt)
    .sort()
    .at(-1)!
  await Bun.sleep(2)
  await unvoidRecordRun({ ...tenant, id: recordId, note: 'mistaken scored void' })
  await unvoidRecordRun({ ...tenant, id: unscoredId, note: 'mistaken unscored void' })
  const cache = new Database(':memory:')
  applyMigrations(cache)
  cache
    .query(
      `INSERT INTO run
        (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded)
       VALUES (991,?,?,?,?,?,?,?,?,?), (992,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      String(run.startedAt),
      'codex',
      'probe',
      'prompt',
      6,
      'prompt',
      'ok',
      VOID_EXCLUSION_REASON,
      unscoredId,
      String(run.startedAt),
      'codex',
      'probe',
      'prompt',
      6,
      'prompt',
      'ok',
      VOID_EXCLUSION_REASON,
    )
  cache
    .query(
      `INSERT INTO score (run_id,delivery,quality,note,scored_at,scored_by)
       VALUES (991,'full','right','first',?,'architect')`,
    )
    .run(String(score.scoredAt))
  cache.query("INSERT INTO schema_meta (key,value) VALUES ('record_scores_cursor',?)").run(cursor)
  const memoryClient = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memoryClient,
    listScores: async (query) => ({
      items: await listRecordScores({
        ...tenant,
        updatedSince: query.updatedSince,
        limit: query.limit ?? 100,
        cursor: null,
      }),
      nextCursor: null,
    }),
  })
  try {
    expect(await pullRecordCache(cache)).toMatchObject({ scores: 2 })
    expect(
      cache
        .query<{ id: number; evidence_excluded: string | null }, []>(
          'SELECT id,evidence_excluded FROM run WHERE id IN (991,992) ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 991, evidence_excluded: null },
      { id: 992, evidence_excluded: null },
    ])
    expect(cache.query('SELECT run_id FROM score ORDER BY run_id').all()).toEqual([{ run_id: 991 }])
  } finally {
    installRecordApiClient(memoryClient)
    cache.close()
  }

  Object.assign(score, {
    delivery: 'partial',
    quality: 'mixed',
    note: 'updated',
    scoredAt: '2026-09-15T01:03:00.000Z',
    updatedAt: '2026-09-15T01:03:00.000Z',
  })
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (4,'score',?,?,?)")
    .run(recordId, JSON.stringify(score), String(score.scoredAt))
  expect(await sync(input.actorUrl)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  const rescoredRead = select(input.spaceId, "delivery || '|' || quality || '|' || note")
  await expect(sync(input.ownerUrl)).rejects.toThrow(
    `record sync refuses ${input.ownerRole} credentials; set ORCH_RECORD_URL to the ${input.actorRole} connection`,
  )
  local.close()
  return { actorRead, otherSpaceRead, rescoredRead }
}

export function registerScoreRecordSyncProof(
  input: Parameters<typeof proveScoreRecordSync>[0],
): void {
  test('sync round trip writes and updates a tenant-confined score', async () => {
    const { actorRead, otherSpaceRead, rescoredRead } = await proveScoreRecordSync(input)
    expect(actorRead.code, actorRead.stderr).toBe(0)
    expect(actorRead.stdout).toBe('full|right|first')
    expect(otherSpaceRead.code, otherSpaceRead.stderr).toBe(0)
    expect(otherSpaceRead.stdout).toBe('')
    expect(rescoredRead.code, rescoredRead.stderr).toBe(0)
    expect(rescoredRead.stdout).toBe('partial|mixed|updated')
  })
}
