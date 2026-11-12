import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { addOpenCursorWorktree } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { openCursorWorktrees } from '../workflow/workflow-cursor-worktrees.ts'
import { namedProjectTreePaths } from './tree-keep.ts'

const created: string[] = []

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tree(): string {
  const path = mkdtempSync(join(dir, 'named-project-tree-'))
  created.push(path)
  return path
}

test('named project paths hold a tree named by an open cursor', async () => {
  const project = `cursor-project-${newRecordId()}`
  const worktree = tree()
  addOpenCursorWorktree(db(), { project, worktree })

  expect(namedProjectTreePaths(project, await openCursorWorktrees())).toEqual(
    new Set([realpathSync(worktree)]),
  )
})

test('named project paths hold a tree named by a live run', async () => {
  const project = `live-project-${newRecordId()}`
  const worktree = tree()
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, run)

  expect(namedProjectTreePaths(project, await openCursorWorktrees())).toEqual(
    new Set([realpathSync(worktree)]),
  )
})

test('named project paths canonicalize a symlinked cursor spelling', async () => {
  const project = `symlink-project-${newRecordId()}`
  const worktree = tree()
  const links = tree()
  const link = join(links, 'tree-link')
  mkdirSync(worktree, { recursive: true })
  symlinkSync(worktree, link)
  addOpenCursorWorktree(db(), { project, worktree: link })

  expect(namedProjectTreePaths(project, await openCursorWorktrees())).toEqual(
    new Set([realpathSync(worktree)]),
  )
})

test('named project paths do not hold a terminal run worktree', async () => {
  const project = `terminal-project-${newRecordId()}`
  const worktree = tree()
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, run)

  expect(namedProjectTreePaths(project, await openCursorWorktrees())).toEqual(new Set())
})
