import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { boardClaimTake } from './board-operations.ts'
import { claimBoundToOpenCursor } from './board-claim-cursor-binding.ts'
import { stampEndedClaims } from './board-claim-service.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { seedCurrentWorkflowTreeFixture } from '../workflow/workflow-store.fixture.ts'

const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['plan-task'], 'claim cursor binding fixture')
})

const claimPorts = (d: Database) => ({
  take: ({ project, key, session }: { project: string; key: string; session: string }) =>
    boardClaimTake(
      { project, subject: `task:${key}` },
      { database: d, cwd: '/fixture', taskCursorAuthority: { mode: 'take' as const, session } },
    ),
  release: async () => ({ released: 0 }),
})

async function openBoundCursor(d: Database) {
  const opened = await composeWorkflowWithCursor(
    'plan-task',
    'fixture',
    'feature',
    { key: 'DEV-1' },
    {
      session: 'cursor-owner',
      workflowKey: 'DEV-1',
      taskRecordId: 'task-DEV-1',
      taskStatusCategory: 'open',
    },
    d,
    {},
    {},
    undefined,
    claimPorts(d),
  )
  return opened.cursor!.id
}

test('claim cursor binding matches only an open task cursor owned by the claim session', async () => {
  const d = database()
  const cursor = await openBoundCursor(d)
  const matching = {
    project: 'fixture',
    subject_kind: 'task',
    subject_value: 'DEV-1',
    holder_session: 'cursor-owner',
  }

  expect(claimBoundToOpenCursor({ ...matching, subject_kind: 'path' }, d)).toBeFalse()
  expect(claimBoundToOpenCursor({ ...matching, holder_session: null }, d)).toBeFalse()
  expect(claimBoundToOpenCursor(matching, d)).toBeTrue()
  expect(claimBoundToOpenCursor({ ...matching, holder_session: 'another-session' }, d)).toBeFalse()
  d.query("UPDATE workflow_cursor SET state='done' WHERE number=?").run(cursor)
  expect(claimBoundToOpenCursor(matching, d)).toBeFalse()
})

test('end stamping leaves a lapsed task claim open while its holder cursor is open', async () => {
  const d = database()
  await openBoundCursor(d)
  const clock = Date.now()
  d.query("UPDATE board_claim SET lapses_at='2000-01-01' WHERE subject_kind='task'").run()

  expect(stampEndedClaims(clock, d)).toBe(0)
  expect(
    d.query("SELECT closed_at FROM board_claim WHERE subject_kind='task'").get(),
  ).toEqual({ closed_at: null })
})

test('cursor-bound conflict refusal names cursor lifecycle instead of an expired lease', async () => {
  const d = database()
  await openBoundCursor(d)
  d.query("UPDATE board_claim SET lapses_at='2000-01-01' WHERE subject_kind='task'").run()

  try {
    await boardClaimTake(
      { project: 'fixture', subject: 'task:DEV-1' },
      {
        database: d,
        cwd: '/fixture',
        taskCursorAuthority: { mode: 'start-child', session: 'other-session' },
      },
    )
    throw new Error('expected conflicting claim refusal')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain("session cursor-owner's claim follows that session's open workflow cursor on DEV-1")
    expect(message).toContain('board ask --audience session:cursor-owner')
    expect(message).toContain('ends when the holder finishes or abandons that cursor')
    expect(message).not.toContain('until 2000')
    expect(message).not.toContain('or wait')
  }
})
