import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { flags } from '../../test/fixtures/judgment.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { scoreRun } from '../judgment.ts'
import { machineId } from '../record/machine-identity.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { clearConfinement } from './confinement-ruling.ts'

let fixturePath: string | null = null

afterEach(() => {
  mock.restore()
  if (fixturePath) rmSync(fixturePath, { recursive: true, force: true })
  fixturePath = null
})

function spawnResult(stdout: string): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('clearing confinement preserves the restored root kind when its chain is scored', async () => {
  const project = `confinement-ruling-${newRecordId()}`
  const repo = join(dir, project)
  fixturePath = repo
  const worktree = join(repo, 'worktree')
  const tip = '1234567890abcdef1234567890abcdef12345678'
  mkdirSync(worktree, { recursive: true })
  db()
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(newRecordId(), project, repo, '{}')

  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed', kind: 'escaped' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'confinement_unverified',
    parent: root,
    turn: 2,
  })
  const priorRoot = { status: 'failed', failureKind: 'other', error: 'pre-confinement failure' }
  const priorChild = { status: 'failed', failureKind: 'quota', error: 'vendor quota' }
  db()
    .query(
      `UPDATE run SET repo=?,worktree=?,branch='DEV-1371-test',head_commit=?,input_tree=?,
        error=?,pre_confinement=?,confinement='{}' WHERE record_id=?`,
    )
    .run(project, worktree, tip, tip, priorRoot.error, JSON.stringify(priorRoot), root)
  db()
    .query(
      `UPDATE run SET repo=?,worktree=?,branch='DEV-1371-test',head_commit=?,input_tree=?,
        error='unverified',pre_confinement=?,confinement='{}' WHERE record_id=?`,
    )
    .run(project, worktree, tip, tip, JSON.stringify(priorChild), child)
  const before = new Date().toISOString()
  enqueueRunRecord(db(), root, machineId(), before)
  enqueueRunRecord(db(), child, machineId(), before)
  spyOn(Bun, 'spawnSync').mockImplementation(() => spawnResult(tip))

  clearConfinement(child, { writer: 'architect', note: 'verified', tip: null }, { log: () => {} })

  await scoreRun(
    root,
    flags({ force: true }),
    {
      words: ['full', 'right', 'faithful'],
      note: null,
      auditReason: null,
      notEvidence: NOT_EVIDENCE,
      dashboardAuthorized: false,
    },
    { log: () => {}, error: () => {}, pairHint: ({ id }) => id },
  )

  const payloads = (runId: string) =>
    db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?) ORDER BY id`,
      )
      .all(runId)
      .map(({ payload }) => JSON.parse(payload))
  expect(payloads(child)).toMatchObject([
    { status: 'failed', failureKind: 'confinement_unverified' },
    { status: 'failed', failureKind: 'quota' },
  ])
  expect(payloads(root)).toMatchObject([
    { status: 'failed', failureKind: 'escaped' },
    { status: 'failed', failureKind: 'other' },
    { status: 'failed', failureKind: 'quota' },
    { status: 'failed', failureKind: 'other' },
  ])
  expect(
    db().query('SELECT failure_kind,own_failure_kind FROM run WHERE record_id=?').get(root),
  ).toEqual({ failure_kind: 'other', own_failure_kind: 'other' })
})
