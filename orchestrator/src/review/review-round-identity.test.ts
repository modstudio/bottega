import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  reviewRoundForRecording,
  reviewRoundIdentity,
  reviewRoundOrdinals,
} from './review-round-identity.ts'

describe('review round identity', () => {
  test('equal task patches share an identity and different patches do not', () => {
    const first = reviewRoundIdentity({
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-round',
        patch_id: 'abc',
        path_set: '["a.ts"]',
    })
    expect(first.identity).toBe(
      reviewRoundIdentity({ ...first, launch_key: 'dev-1618', branch: null, patch_id: 'abc', path_set: '["a.ts"]' }).identity,
    )
    expect(first.identity).not.toBe(
      reviewRoundIdentity({ launch_key: 'DEV-1618', branch: null, patch_id: 'def', path_set: '["a.ts"]' }).identity,
    )
  })

  test('is unclassifiable without a task or patch', () => {
    expect(
      reviewRoundIdentity({
        launch_key: null,
        branch: 'no-key',
        patch_id: 'abc',
        path_set: '["a.ts"]',
      }).identity,
    ).toBeNull()
    expect(
      reviewRoundIdentity({
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-round',
        patch_id: null,
        path_set: '["a.ts"]',
      }).identity,
    ).toBeNull()
  })
})

describe('review round ordinals', () => {
  test('assigns first-seen ordinals and keeps the same identity on one round', () => {
    expect(
      reviewRoundOrdinals([
        { task: 'DEV-1', identity: 'a' },
        { task: 'DEV-1', identity: 'a' },
        { task: 'DEV-2', identity: 'x' },
        { task: null, identity: null },
        { task: 'DEV-1', identity: 'b' },
        { task: 'DEV-2', identity: 'y' },
      ]),
    ).toEqual([1, 1, 1, null, 2, 2])
  })
})

describe('review round for recording', () => {
  test('uses the budget counting rule for the next review on a branch', () => {
    const project = newRecordId()
    db()
      .query(
        "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
      )
      .run(project)
    const addPrior = (at: string, patch: string, branch = 'DEV-1618-round') => {
      const review = newRecordId()
      db()
        .query(
          `INSERT INTO review (record_id,number,recorded_at,tier,patch_id,path_set)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),?,3,?,?)`,
        )
        .run(review, at, patch, '["change.ts"]')
      const run = addRun({
        agent: 'codex',
        job: 'review-lens',
        lens: 'correctness',
        startedAt: at,
        repo: 'fixture',
      })
      db()
        .query('UPDATE run SET branch=?,launch_key=?,project_record_id=? WHERE record_id=?')
        .run(branch, 'DEV-1618', project, run)
      db()
        .query(
          `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
           VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
        )
        .run(newRecordId(), review, run)
    }
    addPrior('2026-10-01T00:00:00Z', 'one')
    addPrior('2026-10-02T00:00:00Z', 'one')
    addPrior('2026-10-03T00:00:00Z', 'two', 'DEV-1618-reworked')
    expect(
      reviewRoundForRecording(db(), {
        project_record_id: project,
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-round',
        patch_id: 'one',
        path_set: '["change.ts"]',
      }),
    ).toBe(1)
    expect(
      reviewRoundForRecording(db(), {
        project_record_id: project,
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-round',
        patch_id: 'two',
        path_set: '["change.ts"]',
      }),
    ).toBe(2)
    expect(
      reviewRoundForRecording(db(), {
        project_record_id: project,
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-third-branch',
        patch_id: 'three',
        path_set: '["change.ts"]',
      }),
    ).toBe(3)
    expect(
      reviewRoundForRecording(db(), {
        project_record_id: project,
        launch_key: 'DEV-1618',
        branch: 'DEV-1618-round',
        patch_id: null,
        path_set: '["change.ts"]',
      }),
    ).toBeNull()
  })
})
