import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { removeHookTree } from './tree.ts'

test('tree remove directs an ordinary run through close-out', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-ordinary-tree-${id}`
  db().query('UPDATE run SET worktree=?, cwd=? WHERE id=?').run(path, path, id)

  expect(() => removeHookTree(path)).toThrow(`orch close-out ${id}`)
})

test('tree remove gives an unrecorded project path a git removal command', () => {
  const main = '/projects/hook-tree-removal'
  const path = `${main}/.claude/worktrees/unrecorded-tree`
  upsertProject({ name: 'hook-tree-removal', path: main, settings: {} })

  expect(() => removeHookTree(path)).toThrow(`git -C ${main} worktree remove ${path}`)
})
