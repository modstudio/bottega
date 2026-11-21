import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { database, gather, insertRun, projectId } from './workflow-floor-evidence.fixture.ts'

test('a scored cursor-bound lens run needs no disk artifact by number or id', async () => {
  const d = database()
  const runId = insertRun(d, { project: 'fixture', launchKey: 'DEV-977' })
  d.query("UPDATE run SET job='review-lens' WHERE record_id=?").run(runId)
  d.query(
    `INSERT INTO score (record_id,run_record_id,delivery,quality,fidelity,scored_at)
     VALUES (?,?,'full','right','faithful','2026-09-01')`,
  ).run(newRecordId(), runId)
  const number = d
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(runId)!.number

  for (const reference of [String(number), runId]) {
    expect((await gather(d, { artifacts: [reference] })).artifacts?.[0]?.artifact).toEqual({
      ref: reference,
      exists: true,
    })
  }
})

test('a bare number still refuses a run bound to another cursor', async () => {
  const d = database()
  const runId = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-1',
    branch: 'DEV-1-work',
  })
  const number = d
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(runId)!.number

  await expect(gather(d, { artifacts: [String(number)] })).rejects.toThrow(
    `--artifact ${number} task reference is task-DEV-1, not this cursor's DEV-977`,
  )
})

test('a task document on the cursor task is stable recorded evidence', async () => {
  const d = database()
  const readTaskDocument = async (value: string) => ({ id: 'document-id', label: value })

  expect(
    (await gather(d, { artifacts: ['DEV-977/1'] }, { readTaskDocument })).artifacts?.[0]?.artifact,
  ).toEqual({ ref: 'DEV-977/1', exists: true })
})

test('a task document on another task is refused before it is read', async () => {
  const readTaskDocument = async () => {
    throw new Error('another task must not be read')
  }

  await expect(
    gather(database(), { artifacts: ['DEV-1/1'] }, { readTaskDocument }),
  ).rejects.toThrow("--artifact DEV-1/1 task is not this cursor's DEV-977")
})

test('a missing task document refusal names its form and cursor task', async () => {
  const readTaskDocument = async () => {
    throw new Error('no task document DEV-977/2')
  }

  await expect(
    gather(database(), { artifacts: ['DEV-977/2'] }, { readTaskDocument }),
  ).rejects.toThrow("--artifact DEV-977/2 does not exist for this cursor's task DEV-977")
})

test('doc UUID evidence still resolves only through the doc store', async () => {
  const d = database()
  const id = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('project','fixture','unchanged','t','b','inject','["technical"]','t','t',?,?)`,
  ).run(projectId(d, 'fixture'), id)

  expect((await gather(d, { artifacts: [`doc:${id}`] })).artifacts?.[0]?.artifact).toEqual({
    ref: 'doc:project/fixture/unchanged',
    exists: true,
  })
})
