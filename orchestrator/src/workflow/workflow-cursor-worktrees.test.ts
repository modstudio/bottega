import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import {
  catalogueVersionRecordId,
  hostedCursorStageFixture,
  workflowVersionRecordId,
} from '../../test/fixtures/workflow.ts'
import { STANDARD_OPEN_HOOKS } from '../runtime/store-hooks.ts'
import { openKeylessCursorsForSession } from './workflow-cursor-list.ts'
import { database } from './workflow-cursor-test.fixture.ts'
import {
  clearOpenCursorWorktreesAtPath,
  openCursorWorktrees,
  openCursorWorktreesAtSpellings,
  workflowCursorBranchAndWorktree,
  workflowCursorClaimHandles,
} from './workflow-cursor-worktrees.ts'

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

test('reads valid worktree arguments only from open workflow cursors', async () => {
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

  expect(await openCursorWorktrees(d)).toEqual([
    { number: 1, workflow: 'fixture', project: 'fixture', worktree: '/trees/running' },
    { number: 2, workflow: 'fixture', project: 'fixture', worktree: '/trees/awaiting' },
  ])
})

test('cursor claim handles include worktree and branch and ignore malformed arguments', () => {
  expect(
    workflowCursorClaimHandles(
      JSON.stringify({ worktree: '/trees/work', branch: 'DEV-2293-work' }),
    ),
  ).toEqual(['/trees/work', 'DEV-2293-work'])
  expect(workflowCursorClaimHandles('{malformed')).toEqual([])
})

test('cursor branch and worktree handles are trimmed and nullable', () => {
  expect(
    workflowCursorBranchAndWorktree(
      JSON.stringify({ worktree: ' /trees/work ', branch: ' DEV-2293-work ' }),
    ),
  ).toEqual({ worktree: '/trees/work', branch: 'DEV-2293-work' })
  expect(workflowCursorBranchAndWorktree(JSON.stringify({ worktree: ' ', branch: 42 }))).toEqual({
    worktree: null,
    branch: null,
  })
})

test('clears every open cursor worktree pointer at a removed path and records the change', async () => {
  const d = database()
  const path = `/trees/removed-${newRecordId()}`
  const insert = d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
       question,total_steps,created_at,updated_at,enforcement)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fixture','default',
             '', '',NULL,?,?,?,0,'research',?,'[]',NULL,1,'2026-10-27','2026-10-27','floors')`,
  )
  const ids = ['running', 'awaiting-ruling', 'done'].map((state) => {
    const id = newRecordId()
    insert.run(
      id,
      workflowVersionRecordId(d),
      catalogueVersionRecordId(d),
      JSON.stringify({ worktree: path, branch: 'DEV-2218-work' }),
      state,
    )
    return id
  })
  const unrelated = newRecordId()
  insert.run(
    unrelated,
    workflowVersionRecordId(d),
    catalogueVersionRecordId(d),
    JSON.stringify({ worktree: '/trees/unrelated', branch: 'other-work' }),
    'running',
  )

  const hostedStages = [ids[0]!, ids[1]!, unrelated].map((id) => hostedCursorStageFixture(d, id))
  const previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  d.query(
    `INSERT INTO record_install_binding (id,bound_at,record_origin)
     VALUES (1,'2026-11-18T00:00:00.000Z','https://record.example.test')`,
  ).run()
  const guarded = STANDARD_OPEN_HOOKS.access!(d)
  const memory = createMemoryRecordApiClient({ taskFlowStages: hostedStages })
  const client = {
    ...memory,
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: 'fixture-space',
      personalSpaceId: 'fixture-space',
      memberships: [{ space_id: 'fixture-space', slug: 'fixture', permission: 'write' as const }],
    }),
  }

  try {
    expect(await openCursorWorktreesAtSpellings([path], guarded, client)).toEqual([
      expect.objectContaining({ number: 1, project: 'fixture', worktree: path }),
      expect.objectContaining({ number: 2, project: 'fixture', worktree: path }),
    ])
    expect(await clearOpenCursorWorktreesAtPath([path], guarded, client)).toBe(2)
  } finally {
    if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
  }
  expect(hostedStages.slice(0, 2).map((row) => row.stage.arguments)).toEqual([
    { branch: 'DEV-2218-work' },
    { branch: 'DEV-2218-work' },
  ])
  expect(hostedStages[0]!.stage.closedStepNotes).toContainEqual(
    expect.objectContaining({ event: 'argument-rebound', name: 'worktree', oldValue: path }),
  )
  const rows = [...ids, unrelated].map((id) =>
    d
      .query<{ args: string; closed: string }, [string]>(
        'SELECT args,closed FROM workflow_cursor WHERE record_id=?',
      )
      .get(id),
  )
  expect(rows.slice(0, 2).map((row) => JSON.parse(row!.args))).toEqual([
    { worktree: path, branch: 'DEV-2218-work' },
    { worktree: path, branch: 'DEV-2218-work' },
  ])
  expect(JSON.parse(rows[0]!.closed)).toEqual([])
  expect(JSON.parse(rows[2]!.args)).toEqual({ worktree: path, branch: 'DEV-2218-work' })
  expect(JSON.parse(rows[3]!.args)).toEqual({
    worktree: '/trees/unrelated',
    branch: 'other-work',
  })
  expect(JSON.parse(rows[3]!.closed)).toEqual([])
})

test('open keyless cursor reader excludes a done cursor and task-bound cursor', async () => {
  const d = database()
  const insert = d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
       question,total_steps,created_at,updated_at,enforcement)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fixture','default',
             ?, ?, 'reader-session', ?, ?, '{}',0,'research',?,'[]',NULL,1,
             '2026-10-27','2026-10-27','floors')`,
  )
  const add = (key: string, state: string) => {
    const recordId = newRecordId()
    insert.run(
      recordId,
      key,
      key ? 'primary' : recordId,
      workflowVersionRecordId(d),
      catalogueVersionRecordId(d),
      state,
    )
    return recordId
  }
  const open = add('', 'running')
  add('', 'done')
  add('DEV-2293', 'running')

  expect(
    (await openKeylessCursorsForSession('reader-session', d)).map((row) => row.record_id),
  ).toEqual([open])
})
