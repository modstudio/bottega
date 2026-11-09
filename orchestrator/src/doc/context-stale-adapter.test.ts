import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db, sessionId } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { encodeContextItem } from './context-item-codec.ts'
import { staleContextForSession } from './context-stale-adapter.ts'

const setLaunchKey = (runId: string, key: string | null) =>
  db().query('UPDATE run SET launch_key=? WHERE record_id=?').run(key, runId)

const registerDevPrefix = () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'context-stale-fixture',
    path: '/tmp/context-stale-fixture',
    settings: { keyPrefixes: ['DEV'] },
  })
}

const insertNextAction = (recordId: string, at: string) => {
  const body = encodeContextItem({ kind: 'next-action', source: 'test', body: 'Continue.' })
  db()
    .query(
      `INSERT INTO doc
     (record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
     VALUES (?,'context',?,'next','next',?,'demand','["technical"]',?,?)`,
    )
    .run(newRecordId(), `task:${recordId}`, body, at, at)
}

test('gathers run, closed-step, and both answer forms through store-backed context revisions', async () => {
  registerDevPrefix()
  const staleRecordId = newRecordId()
  const freshRecordId = newRecordId()
  const session = sessionId()!
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    session,
    startedAt: '2026-11-08T11:00:00Z',
  })
  setLaunchKey(root, 'DEV-STALE')
  const turn = addRun({
    agent: 'codex',
    job: 'implement',
    session,
    parent: root,
    turn: 2,
    startedAt: '2026-11-08T11:30:00Z',
  })
  setLaunchKey(turn, null)
  const fresh = addRun({
    agent: 'codex',
    job: 'implement',
    session,
    startedAt: '2026-11-08T12:00:00Z',
  })
  setLaunchKey(fresh, 'DEV-FRESH')

  db()
    .query(
      `INSERT INTO workflow_cursor
     (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
      workflow_version_record_id,catalogue_version_record_id,ordinal,step_slug,state,args,closed,
      total_steps,created_at,updated_at)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','flow','default',
      'DEV-STALE','',?,?,?,1,'finish','done','{}',?,1,'2026-11-08T10:00:00Z','2026-11-08T12:30:00Z')`,
    )
    .run(
      newRecordId(),
      session,
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      JSON.stringify([{ n: 1, slug: 'build', note: 'Done.', at: '2026-11-08T12:30:00Z' }]),
    )
  for (const [runId, answeredBy, answeredAt] of [
    [root, session, '2026-11-08T13:00:00Z'],
    [turn, `operator via ${session}`, '2026-11-08T14:00:00Z'],
  ] as const) {
    db()
      .query(
        `INSERT INTO question
       (record_id,number,run_record_id,asked_at,question,answer,answered_at,answered_by)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-11-08T10:00:00Z','Which?','This.',?,?)`,
      )
      .run(newRecordId(), runId, answeredAt, answeredBy)
  }
  insertNextAction(staleRecordId, '2026-11-08T10:30:00Z')
  insertNextAction(freshRecordId, '2026-11-08T15:00:00Z')

  expect(
    await staleContextForSession(
      session,
      db(),
      async (project) => [
        {
          key: 'DEV-STALE',
          record_id: staleRecordId,
          project,
          status_category: 'active',
        },
        {
          key: 'DEV-FRESH',
          record_id: freshRecordId,
          project,
          status_category: 'active',
        },
      ],
      '2026-11-09T10:00:00Z',
    ),
  ).toEqual([
    {
      holder: 'DEV-STALE',
      workedAt: '2026-11-08T14:00:00Z',
      revisedAt: '2026-11-08T10:30:00Z',
    },
  ])
})

test('question work prefers the owning run launch key over its workflow key', async () => {
  registerDevPrefix()
  const runTaskRecordId = newRecordId()
  const session = sessionId()!
  const run = addRun({
    agent: 'codex',
    job: 'implement',
    session,
    startedAt: '2026-11-08T11:00:00Z',
  })
  setLaunchKey(run, 'DEV-RUN')
  db()
    .query(
      `INSERT INTO question
       (record_id,number,run_record_id,workflow_key,asked_at,question,answer,answered_at,answered_by)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'DEV-WORKFLOW',
        '2026-11-08T11:30:00Z','Which holder?','The run holder.',
        '2026-11-08T12:00:00Z',?)`,
    )
    .run(newRecordId(), run, session)
  insertNextAction(runTaskRecordId, '2026-11-08T10:00:00Z')

  expect(
    await staleContextForSession(
      session,
      db(),
      async (project) => [
        { key: 'DEV-RUN', record_id: runTaskRecordId, project, status_category: 'active' },
      ],
      '2026-11-09T10:00:00Z',
    ),
  ).toEqual([
    {
      holder: 'DEV-RUN',
      workedAt: '2026-11-08T12:00:00Z',
      revisedAt: '2026-11-08T10:00:00Z',
    },
  ])
})
