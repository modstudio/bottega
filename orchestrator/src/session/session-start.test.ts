import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
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
