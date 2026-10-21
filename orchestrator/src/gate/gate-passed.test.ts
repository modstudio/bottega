import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { formatPassingGate, passingGateForCommit, selectPassingGateId } from './gate-passed.ts'

const repositoryPath = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

test('a passing gate belongs to the exact project', () => {
  const candidates = [
    { id: 3, projectId: 'project-2', cwd: null },
    { id: 2, projectId: null, cwd: '/projects/fixture/worktree' },
    { id: 1, projectId: 'project-1', cwd: null },
  ]
  expect(selectPassingGateId(candidates, 'project-1', () => 'project-1')).toBe(2)
  expect(selectPassingGateId(candidates, 'project-1', () => 'project-2')).toBe(1)
  expect(selectPassingGateId(candidates, 'project-4', () => 'project-2')).toBeNull()
})

test('the hook result is one line for either outcome', () => {
  expect(formatPassingGate({ project: 'fixture', commit: 'abc', gateId: 9 })).toBe(
    'passing gate 9 recorded for fixture commit abc',
  )
  expect(formatPassingGate({ project: 'fixture', commit: 'abc', gateId: null })).toBe(
    'no passing gate recorded for fixture commit abc',
  )
})

test('a timed-out zero-exit gate is not a passing gate', () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run('fixture', repositoryPath, 'bun', '{}')
  const commit = 'a'.repeat(40)
  const gate = d
    .query(
      `INSERT INTO gate_execution
        (record_id, requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
       VALUES ('${newRecordId()}', '2026-10-09','2026-10-09',0,1,100,'timed out',?,?) RETURNING id`,
    )
    .get(commit, repositoryPath) as { id: number }

  expect(passingGateForCommit(commit, repositoryPath, d).gateId).toBeNull()

  d.query('UPDATE gate_execution SET timed_out=0 WHERE id=?').run(gate.id)
  expect(passingGateForCommit(commit, repositoryPath, d).gateId).toBe(gate.id)
})
