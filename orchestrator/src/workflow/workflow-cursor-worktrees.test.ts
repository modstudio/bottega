import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { database } from './workflow-cursor-test.fixture.ts'
import { openCursorWorktrees } from './workflow-cursor-worktrees.ts'

let priorRunId: string | undefined
let priorDepth: string | undefined

beforeEach(() => {
  priorRunId = process.env.BOTTEGA_RUN_ID
  priorDepth = process.env.BOTTEGA_DEPTH
  delete process.env.BOTTEGA_RUN_ID
  delete process.env.BOTTEGA_DEPTH
})

afterEach(() => {
  if (priorRunId === undefined) delete process.env.BOTTEGA_RUN_ID
  else process.env.BOTTEGA_RUN_ID = priorRunId
  if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = priorDepth
})

test('reads valid worktree arguments only from open workflow cursors', () => {
  const d = database()
  const insert = d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
       question,total_steps,created_at,updated_at,enforcement)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fixture','default',
             '', '',NULL,?,?,?,0,'research',?,'[]',NULL,1,'2026-10-27','2026-10-27','floors')`,
  )
  const add = (state: string, args: string) =>
    insert.run(newRecordId(), workflowVersionRecordId(d), catalogueVersionRecordId(d), args, state)

  add('running', JSON.stringify({ worktree: '/trees/running' }))
  add('awaiting-ruling', JSON.stringify({ worktree: '/trees/awaiting' }))
  add('done', JSON.stringify({ worktree: '/trees/done' }))
  add('abandoned', JSON.stringify({ worktree: '/trees/abandoned' }))
  add('running', JSON.stringify({ other: '/trees/missing' }))
  add('running', JSON.stringify({ worktree: '   ' }))
  add('running', '{malformed')

  expect(openCursorWorktrees(d)).toEqual([
    { project: 'fixture', worktree: '/trees/running' },
    { project: 'fixture', worktree: '/trees/awaiting' },
  ])
})
