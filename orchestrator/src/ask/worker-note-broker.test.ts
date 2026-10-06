import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { startWorkerNoteBroker } from './worker-note-broker.ts'

afterEach(() => mock.restore())

test('host broker derives run facts and completes a requested note', async () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const project = db()
    .query(`INSERT INTO project (name,path,settings) VALUES (?,?,?) RETURNING id`)
    .get('worker-note-broker', '/projects/main', '{}') as { id: number }
  db()
    .query(`UPDATE run SET project_id=?,worktree=?,branch=?,session_id=?,head_commit=? WHERE id=?`)
    .run(project.id, '/runs/tree', 'DEV-1029-worker', 'session-42', 'abc123', runId)
  const request = db()
    .query(
      `INSERT INTO worker_note_request (run_id,text,file,requested_at,status)
       VALUES (?,?,NULL,?,'requested') RETURNING id`,
    )
    .get(runId, 'outside defect', new Date().toISOString()) as { id: number }
  const seen: unknown[] = []
  const broker = startWorkerNoteBroker(runId, async (run, input) => {
    seen.push(run, input)
    return { noteId: 71, candidateIds: [8, 13] }
  })
  try {
    let filed = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = db()
        .query(`SELECT status,note_id,candidate_ids FROM worker_note_request WHERE id=?`)
        .get(request.id) as { status: string; note_id: number | null; candidate_ids: string }
      if (row.status === 'filed') {
        expect(row).toEqual({ status: 'filed', note_id: 71, candidate_ids: '[8,13]' })
        filed = true
        break
      }
      await Bun.sleep(10)
    }
    expect(filed).toBe(true)
    expect(seen).toEqual([
      {
        id: runId,
        project: 'worker-note-broker',
        projectPath: '/projects/main',
        tree: '/runs/tree',
        branch: 'DEV-1029-worker',
        sessionId: 'session-42',
        headCommit: 'abc123',
      },
      { text: 'outside defect' },
    ])
  } finally {
    await broker.close()
  }
})

test('host broker retries a claim that throws on a later poll tick', async () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const project = db()
    .query(`INSERT INTO project (name,path,settings) VALUES (?,?,?) RETURNING id`)
    .get('worker-note-retry', '/projects/main', '{}') as { id: number }
  db()
    .query(`UPDATE run SET project_id=?,worktree=? WHERE id=?`)
    .run(project.id, '/runs/tree', runId)
  const request = db()
    .query(
      `INSERT INTO worker_note_request (run_id,text,file,requested_at,status)
       VALUES (?,?,NULL,?,'requested') RETURNING id`,
    )
    .get(runId, 'retry this note', new Date().toISOString()) as { id: number }
  const database = db()
  const transaction = database.transaction.bind(database)
  let attempts = 0
  spyOn(database, 'transaction').mockImplementation(((operation: () => unknown) => {
    attempts += 1
    if (attempts === 1) throw new Error('database is locked')
    return transaction(operation)
  }) as typeof database.transaction)
  const broker = startWorkerNoteBroker(runId, async () => ({ noteId: 72, candidateIds: [] }))
  try {
    let filed = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = db()
        .query(`SELECT status FROM worker_note_request WHERE id=?`)
        .get(request.id) as { status: string }
      if (row.status === 'filed') {
        filed = true
        break
      }
      await Bun.sleep(10)
    }
    expect(filed).toBe(true)
    expect(attempts).toBeGreaterThan(1)
  } finally {
    await broker.close()
  }
})
