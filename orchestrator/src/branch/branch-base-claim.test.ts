import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { liveBaseClaim } from './branch-base-claim.ts'

test('a fully qualified base name is claimed while its chain is asking and released when finished', () => {
  const projectRecordId = (
    db()
      .query(
        "INSERT INTO project (record_id,name,path,settings) VALUES ('01990000-0000-7000-8000-000000001214','live-base-claim','/unused','{}') RETURNING record_id",
      )
      .get() as { record_id: string }
  ).record_id
  const project: Project = {
    recordId: '01990000-0000-7000-8000-000000001214',
    name: 'live-base-claim',
    path: '/unused',
    stack: null,
    canon: false,
    retiredAt: null,
    settings: {},
  }
  const branch = 'DEV-1071-orch-old'
  const holder = addRun({
    agent: 'codex',
    job: 'implement',
    repo: project.name,
    status: 'asking',
  })
  db()
    .query('UPDATE run SET project_record_id=?,launch_base=? WHERE id=?')
    .run(projectRecordId, `refs/heads/${branch}`, holder)

  expect(liveBaseClaim(project, branch)).toEqual({ run_id: holder, status: 'asking' })

  db().query("UPDATE run SET status='ok' WHERE id=?").run(holder)
  expect(liveBaseClaim(project, branch)).toBeNull()
})

