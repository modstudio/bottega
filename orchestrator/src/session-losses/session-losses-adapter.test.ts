import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addOpenCursorWorktree } from '../../test/fixtures/workflow.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordContextReview } from '../session/context-review-store.ts'
import { briefsAtBoundaries, contextReviewMeasurements } from './session-losses-adapter.ts'

test('brief measurements attach to their compaction boundary and stay blank when absent', () => {
  expect(
    briefsAtBoundaries(
      ['2026-11-13T12:00:00.000Z', '2026-11-13T13:00:00.000Z'],
      [
        {
          at: '2026-11-13T12:00:01.000Z',
          bytes: 10_120,
          lines: 80,
          over_cap: 1,
        },
      ],
    ),
  ).toEqual([{ bytes: 10_120, lines: 80, overCap: true }, null])
})

test('review measurements batch every recorded holder so a present task item is not dropped', async () => {
  const database = migratedTestDatabase()
  const at = '2026-11-13T12:00:00.000Z'
  recordContextReview(
    {
      sessionId: 'session-a',
      intervalMs: 1_000,
      items: 1,
      flagged: 0,
      itemIds: ['task-item'],
      itemHolders: ['task:task-a'],
    },
    { database, now: () => at, machine: () => '01990000-0000-7000-8000-000000000099' },
  )
  const calls: string[][] = []

  const measured = await contextReviewMeasurements('session-a', [], {
    database,
    readItems: async (holders) => {
      calls.push(typeof holders === 'string' ? [holders] : [...holders])
      return [
        {
          recordId: 'task-item',
          holder: 'task:task-a',
          id: 'fact',
          kind: 'fact',
          body: 'still present',
          source: 'test',
          questionNumber: null,
          target: null,
          revision: at,
          createdAt: at,
          updatedAt: at,
        },
      ]
    },
  })

  expect(calls).toEqual([['session:session-a', 'task:task-a']])
  expect(measured.reviews).toEqual([{ at, listed: 1, flagged: 0, revised: 0, dropped: 0 }])
  database.close()
})

test('review measurements count a compaction capture on a task named by a session run', async () => {
  const database = migratedTestDatabase()
  const session = 'capture-session'
  const taskRecordId = 'capture-task'
  const cursorTaskRecordId = 'cursor-task'
  const boundaryAt = '2026-11-13T12:00:00.000Z'
  const capturedAt = '2026-11-13T12:00:01.000Z'
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
        session_id,task_record_id,project_record_id,turn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      1,
      boundaryAt,
      'codex',
      'implement',
      'prompt-sha',
      'spec-sha',
      10,
      'head',
      'ok',
      session,
      taskRecordId,
      fixtureProjectRecordId(database),
      1,
    )
  const cursor = addOpenCursorWorktree(database, {
    project: 'fixture',
    worktree: '/tmp/capture-cursor',
  })
  database
    .query('UPDATE workflow_cursor SET session_id=?,task_record_id=? WHERE number=?')
    .run(session, cursorTaskRecordId, cursor)
  const calls: string[][] = []

  const measured = await contextReviewMeasurements(
    session,
    [{ at: boundaryAt }] as Parameters<typeof contextReviewMeasurements>[1],
    {
      database,
      readItems: async (holders) => {
        calls.push(typeof holders === 'string' ? [holders] : [...holders])
        return [
          {
            recordId: 'capture-item',
            holder: `task:${taskRecordId}`,
            id: 'capture',
            kind: 'fact',
            body: 'captured',
            source: `compaction ${session}`,
            questionNumber: null,
            target: null,
            revision: capturedAt,
            createdAt: capturedAt,
            updatedAt: capturedAt,
          },
        ]
      },
    },
  )

  expect(calls).toEqual([
    [`session:${session}`, `task:${taskRecordId}`, `task:${cursorTaskRecordId}`],
  ])
  expect(measured.captured).toEqual([1])
  database.close()
})
