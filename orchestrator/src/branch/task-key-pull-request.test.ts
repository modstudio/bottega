import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { branchForTaskKey, pullRequestNumberForBranch } from './task-key-pull-request.ts'

const database = testDatabaseFixture((d) => {
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run('fixture', '/fixture', 'bun', '{}')
})

test('prefers the cursor branch when it is recorded', () => {
  expect(branchForTaskKey('fixture', 'DEV-977', 'DEV-977-work', database())).toBe('DEV-977-work')
})

test('finds a landing whose branch starts with the task key', () => {
  const d = database()
  d.query(
    `INSERT INTO branch_landing_record
      (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES (?,'fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run(newRecordId())
  expect(branchForTaskKey('fixture', 'DEV-977', null, d)).toBe('DEV-977-work')
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(12)
})

test('falls back to a triage snapshot when no landing record exists', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',15,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(branchForTaskKey('fixture', 'DEV-977', null, d)).toBe('DEV-977-work')
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(15)
})

test('a landing record wins over a snapshot for the same branch', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',15,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  d.query(
    `INSERT INTO branch_landing_record
      (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES (?,'fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run(newRecordId())
  expect(pullRequestNumberForBranch('fixture', 'DEV-977-work', d)).toBe(12)
})

test('a different project or key does not match', () => {
  const d = database()
  d.query(
    `INSERT INTO branch_landing_record
      (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES (?,'fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc',12,'def','2026-09-01','2026-09-01')`,
  ).run(newRecordId())
  expect(branchForTaskKey('other', 'DEV-977', null, d)).toBeNull()
  expect(branchForTaskKey('fixture', 'DEV-978', null, d)).toBeNull()
  expect(pullRequestNumberForBranch('other', 'DEV-977-work', d)).toBeNull()
})
