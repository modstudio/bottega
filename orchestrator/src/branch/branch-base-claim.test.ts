import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { liveBaseClaim } from './branch-base-claim.ts'

test('a fully qualified base name is claimed while its chain is asking and released when finished', () => {
  const projectId = (
    db()
      .query(
        "INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'live-base-claim','/unused','{}') RETURNING id",
      )
      .get() as { id: number }
  ).id
  const project: Project = {
    id: projectId,
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
    .query('UPDATE run SET project_id=?,launch_base=? WHERE id=?')
    .run(project.id, `refs/heads/${branch}`, holder)

  expect(liveBaseClaim(project, branch)).toEqual({ run_id: holder, status: 'asking' })

  db().query("UPDATE run SET status='ok' WHERE id=?").run(holder)
  expect(liveBaseClaim(project, branch)).toBeNull()
})

