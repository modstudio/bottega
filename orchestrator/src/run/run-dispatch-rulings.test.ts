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

test('task text is carried only on the first turn of a keyed writing job', async () => {
  const projectName = 'task-text-dispatch'
  const projectRecordId = addProject(projectName, `/work/${projectName}`)
  const parent = addRun({ agent: 'codex', job: 'implement', projectRecordId })
  const reads: string[] = []
  const taskTextReader = async (_project: unknown, key: string) => {
    reads.push(key)
    return {
      available: true as const,
      recordId: null,
      key,
      title: 'Carried title',
      body: 'Carried body',
      comments: [],
    }
  }
  const base = {
    workspaceSource: 'retained' as const,
    parentRunRecordId: parent,
    projectName,
    projectRecordId,
    repoJob: true,
    callerCwd: `/work/${projectName}`,
    probe: false,
  }

  const first = await prepareRunDispatchRulings(
    { ...base, firstTurn: true, writesJob: true, key: 'DEV-2222' },
    { taskTextReader },
  )
  expect(first.taskText).toContain('DEV-2222 — Carried title')
  expect(first.taskText).toContain('Carried body')
  expect(reads).toEqual(['DEV-2222'])

  for (const input of [
    { firstTurn: false, writesJob: true, key: 'DEV-2222' },
    { firstTurn: true, writesJob: false, key: 'DEV-2222' },
    { firstTurn: true, writesJob: true, key: null },
  ]) {
    const prepared = await prepareRunDispatchRulings({ ...base, ...input }, { taskTextReader })
    expect(prepared.taskText).toBe('')
  }
  expect(reads).toEqual(['DEV-2222'])
})
