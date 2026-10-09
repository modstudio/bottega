import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { runEventsPath } from '../events.ts'
import { startWorkerNoteBroker } from './worker-note-broker.ts'
import { requestWorkerNote } from './worker-note-request.ts'

afterEach(() => mock.restore())

test('host broker derives run facts and completes a requested note', async () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const project = db()
    .query(`INSERT INTO project (name,path,settings) VALUES (?,?,?) RETURNING id`)
    .get('worker-note-broker', '/projects/main', '{}') as { id: number }
  db()
    .query(`UPDATE run SET project_id=?,worktree=?,branch=?,session_id=?,head_commit=? WHERE id=?`)
    .run(project.id, '/runs/tree', 'DEV-1029-worker', 'session-42', 'abc123', runId)
  const seen: unknown[] = []
  const broker = startWorkerNoteBroker(runId, async (run, input) => {
    seen.push(run, input)
    return {
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidateNotes: [
        { recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' },
        { recordId: '01990000-0000-7000-8000-000000000013', label: 'workshop#13' },
      ],
    }
  })
  try {
    const filed = await requestWorkerNote(
      {
        id: runId,
        project: 'worker-note-broker',
        projectPath: '/projects/main',
        tree: '/runs/tree',
        branch: 'DEV-1029-worker',
        sessionId: 'session-42',
        headCommit: 'abc123',
      },
      { text: 'outside defect', sameAs: 'workshop#7' },
    )
    expect(filed).toEqual({
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidateNotes: [
        { recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' },
        { recordId: '01990000-0000-7000-8000-000000000013', label: 'workshop#13' },
      ],
    })
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
      { text: 'outside defect', sameAs: 'workshop#7' },
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
  const broker = startWorkerNoteBroker(runId, async () => ({
    noteRecordId: '01990000-0000-7000-8000-000000000072',
    noteLabel: 'workshop#72',
    candidateNotes: [],
  }))
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

test('host broker records one permanent claim failure and stops polling', async () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const database = db()
  let attempts = 0
  spyOn(database, 'transaction').mockImplementation((() => {
    attempts += 1
    throw new Error('broken claim query')
  }) as typeof database.transaction)

  const broker = startWorkerNoteBroker(runId)
  await Bun.sleep(250)
  expect(attempts).toBe(1)
  const events = readFileSync(runEventsPath(runId), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { text?: string })
  expect(events).toHaveLength(1)
  expect(events[0]?.text).toContain('broken claim query')
  await broker.close()
})
