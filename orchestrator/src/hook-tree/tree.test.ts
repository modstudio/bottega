import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  absentClaimedHookTreeDecision,
  cursorWorktreeCleanupFailure,
  hookTreeSeedRequest,
  removeHookTree,
  removeHookTreeResult,
} from './tree.ts'

test('hook-tree seed request carries the command-line seed', () => {
  expect(
    hookTreeSeedRequest({
      requested: 'full',
      project: null,
      tool: null,
      baseRef: 'main',
    }),
  ).toMatchObject({ requested: 'full', baseRef: 'main' })
})

test('tree remove directs an ordinary run through close-out', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-ordinary-tree-${id}`
  db().query('UPDATE run SET worktree=?, cwd=? WHERE record_id=?').run(path, path, id)

  await expect(removeHookTree(path)).rejects.toThrow(`${PLATFORM_SLUG} run close-out ${id}`)
})

test('tree remove gives an unrecorded project path a git removal command', async () => {
  const main = '/projects/hook-tree-removal'
  const path = `${main}/.claude/worktrees/unrecorded-tree`
  upsertProject({ recordId: newRecordId(), name: 'hook-tree-removal', path: main, settings: {} })

  await expect(removeHookTree(path)).rejects.toThrow(`git -C ${main} worktree remove ${path}`)
})

test('an absent path is absent only when a historical worktree claim names it', () => {
  expect(
    absentClaimedHookTreeDecision({ pathExists: false, hasHistoricalWorktreeClaim: true }),
  ).toBe('absent')
  expect(
    absentClaimedHookTreeDecision({ pathExists: true, hasHistoricalWorktreeClaim: true }),
  ).toBe('refuse')
  expect(
    absentClaimedHookTreeDecision({ pathExists: false, hasHistoricalWorktreeClaim: false }),
  ).toBe('refuse')
})

test('a repeated removal reports an absent tree from its released claim', async () => {
  const id = addRun({ agent: '(hook)', job: 'hook-tree', status: 'ok' })
  const path = `/no-such-released-hook-tree-${id}`
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,settled_at)
       VALUES (?,?,?,'worktree',?,'released',?,?)`,
    )
    .run(newRecordId(), id, id, path, nowIso(), nowIso())

  const cursorId = newRecordId()
  db()
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,ordinal,
        step_slug,state,closed,total_steps,created_at,updated_at,enforcement)
       VALUES (?,1,'fixture','fixture','default','','',?,?,?,0,'research','running','[]',1,?,?, 'floors')`,
    )
    .run(
      cursorId,
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      JSON.stringify({ worktree: path, branch: 'DEV-2218-work' }),
      nowIso(),
      nowIso(),
    )

  expect(await removeHookTreeResult(path)).toEqual({ outcome: 'absent' })
  expect(
    JSON.parse(
      db()
        .query<{ args: string }, [string]>('SELECT args FROM workflow_cursor WHERE record_id=?')
        .get(cursorId)!.args,
    ),
  ).toEqual({ branch: 'DEV-2218-work' })
})

test('a cursor cleanup failure preserves the successful tree result and names its remedy', () => {
  expect(
    cursorWorktreeCleanupFailure({ outcome: 'released' }, '/trees/released', 'record down'),
  ).toEqual({
    outcome: 'released',
    cursorCleanupFailure:
      `the tree at /trees/released was released but the cursor worktree pointers at it could not be cleared: record down; ` +
      `rerun ${PLATFORM_SLUG} tree remove /trees/released to retry, or pass --arg worktree=<tree> on the cursor`,
  })
})
