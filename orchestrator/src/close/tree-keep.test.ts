import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { addOpenCursorWorktree } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
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

test('named project paths hold a tree named by an open cursor', () => {
  const project = `cursor-project-${newRecordId()}`
  const worktree = tree()
  addOpenCursorWorktree(db(), { project, worktree })

  expect(namedProjectTreePaths(project)).toEqual(new Set([realpathSync(worktree)]))
})

test('named project paths hold a tree named by a live run', () => {
  const project = `live-project-${newRecordId()}`
  const worktree = tree()
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, run)

  expect(namedProjectTreePaths(project)).toEqual(new Set([realpathSync(worktree)]))
})

test('named project paths canonicalize a symlinked cursor spelling', () => {
  const project = `symlink-project-${newRecordId()}`
  const worktree = tree()
  const links = tree()
  const link = join(links, 'tree-link')
  mkdirSync(worktree, { recursive: true })
  symlinkSync(worktree, link)
  addOpenCursorWorktree(db(), { project, worktree: link })

  expect(namedProjectTreePaths(project)).toEqual(new Set([realpathSync(worktree)]))
})

test('named project paths do not hold a terminal run worktree', () => {
  const project = `terminal-project-${newRecordId()}`
  const worktree = tree()
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, run)

  expect(namedProjectTreePaths(project)).toEqual(new Set())
})
