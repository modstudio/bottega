import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { prepareRunDispatchRulings } from './run-dispatch-rulings.ts'

test('retry-root carries rulings and claim links from the retained parent task', async () => {
  const projectRecordId = addProject('retry-rulings', '/work/retry-rulings')
  const parent = addRun({ agent: 'codex', job: 'implement', projectRecordId })
  db().query('UPDATE run SET task_record_id=? WHERE record_id=?').run('parent-task-id', parent)
  db()
    .query(
      `INSERT INTO question
       (number,record_id,run_record_id,asked_at,question,answer,answered_at,answerer_kind)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'keep the parent task','yes',?,'operator')`,
    )
    .run(newRecordId(), parent, '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')

  const prepared = await prepareRunDispatchRulings({
    firstTurn: true,
    workspaceSource: 'retained',
    parentRunRecordId: parent,
    projectName: null,
    projectRecordId: null,
    key: 'OTHER-42',
    repoJob: true,
    callerCwd: '/work/retry-rulings',
    probe: false,
  })

  expect(prepared.links).toEqual({
    taskRecordId: 'parent-task-id',
    projectRecordId,
  })
  expect(prepared.section).toContain('keep the parent task')
  expect(prepared.questionIds).toHaveLength(1)
})

test('a retained non-first turn keeps parent links without carrying rulings', async () => {
  const projectRecordId = addProject('retained-rulings', '/work/retained-rulings')
  const parent = addRun({ agent: 'codex', job: 'implement', projectRecordId })
  db().query('UPDATE run SET task_record_id=? WHERE record_id=?').run('parent-task-id', parent)
  db()
    .query(
      `INSERT INTO question
       (number,record_id,run_record_id,asked_at,question,answer,answered_at,answerer_kind)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'keep the parent task','yes',?,'operator')`,
    )
    .run(newRecordId(), parent, '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')

  const prepared = await prepareRunDispatchRulings({
    firstTurn: false,
    workspaceSource: 'retained',
    parentRunRecordId: parent,
    projectName: null,
    projectRecordId: null,
    key: null,
    repoJob: true,
    callerCwd: '/work/retained-rulings',
    probe: false,
  })

  expect(prepared.links).toEqual({
    taskRecordId: 'parent-task-id',
    projectRecordId,
  })
  expect(prepared.section).toBe('')
  expect(prepared.questionIds).toEqual([])
})
