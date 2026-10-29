import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  absentClaimedHookTreeDecision,
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

test('tree remove directs an ordinary run through close-out', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-ordinary-tree-${id}`
  db().query('UPDATE run SET worktree=?, cwd=? WHERE record_id=?').run(path, path, id)

  expect(() => removeHookTree(path)).toThrow(`${PLATFORM_SLUG} run close-out ${id}`)
})

test('tree remove gives an unrecorded project path a git removal command', () => {
  const main = '/projects/hook-tree-removal'
  const path = `${main}/.claude/worktrees/unrecorded-tree`
  upsertProject({ recordId: newRecordId(), name: 'hook-tree-removal', path: main, settings: {} })

  expect(() => removeHookTree(path)).toThrow(`git -C ${main} worktree remove ${path}`)
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

test('a repeated removal reports an absent tree from its released claim', () => {
  const id = addRun({ agent: '(hook)', job: 'hook-tree', status: 'ok' })
  const path = `/no-such-released-hook-tree-${id}`
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,settled_at)
       VALUES (?,?,?,'worktree',?,'released',?,?)`,
    )
    .run(newRecordId(), id, id, path, nowIso(), nowIso())

  expect(removeHookTreeResult(path)).toEqual({ outcome: 'absent' })
})
