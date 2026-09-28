import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { branchForTaskKey, pullRequestNumberForBranch } from './task-key-pull-request.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    '{}',
  )
  return d
}

test('prefers the cursor branch when it is recorded', () => {
  expect(branchForTaskKey('fixture', 'DEV-977', 'DEV-977-work', database())).toBe('DEV-977-work')
})

test('finds a landing whose branch starts with the task key', () => {
  const d = database()
  d.query(
    `INSERT INTO branch_landing_record
      (project,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES ('fixture','DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run()
  expect(branchForTaskKey('fixture', 'DEV-977', null, d)).toBe('DEV-977-work')
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(12)
})

test('falls back to a triage snapshot when no landing record exists', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',15,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(branchForTaskKey('fixture', 'DEV-977', null, d)).toBe('DEV-977-work')
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(15)
})

test('a landing record wins over a snapshot for the same branch', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',15,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  d.query(
    `INSERT INTO branch_landing_record
      (project,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES ('fixture','DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run()
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(12)
})

test('a different project or key does not match', () => {
  const d = database()
  d.query(
    `INSERT INTO branch_landing_record
      (project,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES ('fixture','DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run()
  expect(branchForTaskKey('other', 'DEV-977', null, d)).toBeNull()
  expect(branchForTaskKey('fixture', 'DEV-978', null, d)).toBeNull()
  expect(pullRequestNumberForBranch('other', 'DEV-977-work', d)).toBeNull()
})
