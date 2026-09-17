import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from '../src/run/run-outbox.ts'
import { SCORE_RECORD_PAYLOAD_COLUMNS } from '../src/score/score-outbox.ts'

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
}): Promise<void> {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
  )`)
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
          name: 'Alpha',
          role: 'owner',
          permission: 'write',
        },
        {
          spaceId: input.secondSpaceId,
          slug: 'beta-space',
          name: 'Beta',
          role: 'owner',
          permission: 'write',
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
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
  )`)
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

  Object.assign(score, {
    delivery: 'partial',
    quality: 'mixed',
    note: 'updated',
    scoredAt: '2026-09-15T01:03:00.000Z',
    updatedAt: '2026-09-15T01:03:00.000Z',
  })
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (3,'score',?,?,?)")
    .run(recordId, JSON.stringify(score), String(score.scoredAt))
  expect(await sync(input.actorUrl)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  const rescoredRead = select(input.spaceId, "delivery || '|' || quality || '|' || note")
  await expect(sync(input.ownerUrl)).rejects.toThrow(
    `record sync refuses ${input.ownerRole} credentials; set ORCH_RECORD_URL to the ${input.actorRole} connection`,
  )
  local.close()
  return { actorRead, otherSpaceRead, rescoredRead }
}
