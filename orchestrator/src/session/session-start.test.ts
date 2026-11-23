import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { reapHarnessSessions } from '../harness-session/harness-session.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { seedCurrentWorkflowTreeFixture } from '../workflow/workflow-store.fixture.ts'
import { startSession } from './session-start.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('two starts for one session reuse one keyless explore cursor', async () => {
  const session = newRecordId()
  seedCurrentWorkflowTreeFixture(db(), ['explore'], 'session start fixture', repositoryRoot)

  const first = await startSession({ database: db(), cwd: repositoryRoot, session })
  const second = await startSession({ database: db(), cwd: repositoryRoot, session })
  const cursors = await taskFlowReadStore(db()).listOpenStages({
    project: 'fixture',
    sessionId: session,
  })

  expect(second.cursor).toBe(first.cursor)
  expect(cursors).toHaveLength(1)
  expect(cursors[0]).toMatchObject({
    id: first.cursor,
    workflow_slug: 'explore',
    workflow_key: '',
    session_id: session,
  })

  const otherSession = newRecordId()
  const other = await startSession({ database: db(), cwd: repositoryRoot, session: otherSession })
  const otherCursors = await taskFlowReadStore(db()).listOpenStages({
    project: 'fixture',
    sessionId: otherSession,
  })

  expect(other.cursor).not.toBe(first.cursor)
  expect(otherCursors).toHaveLength(1)
  expect(otherCursors[0]).toMatchObject({
    id: other.cursor,
    workflow_slug: 'explore',
    workflow_key: '',
    session_id: otherSession,
  })
})

test('a harness start publishes the current session through the session service', async () => {
  const session = newRecordId()
  seedCurrentWorkflowTreeFixture(db(), ['explore'], 'session publication fixture', repositoryRoot)

  await startSession({
    database: db(),
    cwd: repositoryRoot,
    session,
    harnessPid: process.pid,
    source: 'compact',
  })

  const published = reapHarnessSessions({ dryRun: true }).publications.find(
    ({ identity }) => identity.pid === process.pid,
  )
  expect(published).toMatchObject({
    session,
    harness: 'claude-code',
    source: 'compact',
  })
})

test('a failed harness publication preserves the cursor and names the remedy', async () => {
  const session = newRecordId()
  seedCurrentWorkflowTreeFixture(db(), ['explore'], 'failed publication fixture', repositoryRoot)

  const result = await startSession({
    database: db(),
    cwd: repositoryRoot,
    session,
    harnessPid: 42,
    observeHarnessStartTime: () => null,
  })

  expect(result.cursor).toBeNumber()
  expect(result.line).toContain(`cursor ${result.cursor} explore`)
  expect(result.line).toContain('could not establish harness pid 42 process start time')
  expect(result.line).toContain('start a new Claude session or run /clear')
})

test('names the open task-bound cursor when composing no explore cursor', async () => {
  const session = newRecordId()
  seedCurrentWorkflowTreeFixture(
    db(),
    ['explore'],
    'session start task-bound fixture',
    repositoryRoot,
  )
  const opened = await startSession({ database: db(), cwd: repositoryRoot, session })
  db()
    .query(
      "UPDATE workflow_cursor SET workflow_slug='plan-task',workflow_key='DEV-2323' WHERE number=?",
    )
    .run(opened.cursor)

  expect(await startSession({ database: db(), cwd: repositoryRoot, session })).toEqual({
    cursor: null,
    line: `cursor ${opened.cursor} plan-task DEV-2323 is open; session start composed no explore cursor`,
  })
})
