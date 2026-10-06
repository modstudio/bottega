import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { commitDocRestore, commitDocSet } from './local-doc-write.ts'

test('set and restore repair the project id on an existing document', () => {
  upsertProject({
    name: 'repair-project',
    path: '/w/repair',
    stack: null,
    canon: true,
    settings: {},
  })
  const project = db().query('SELECT id FROM project WHERE name=?').get('repair-project') as {
    id: number
  }
  const input = {
    scope: 'resume',
    subject: 'repair-project',
    owner: null,
    projectId: project.id,
    slug: 'repair-project-id',
    title: 'Resume',
    body: '---\nstatus: open\n---\n\nBody.',
    delivery: 'demand' as const,
    audience: 'technical' as const,
    parentId: null,
    position: 0,
    identity: { author: 'test', reason: 'repair project id', session: null },
    recordId: newRecordId(),
  }
  const created = commitDocSet({ ...input, revisionId: newRecordId() })

  db().query('UPDATE doc SET project_id=NULL WHERE id=?').run(created.id)
  commitDocSet({ ...input, revisionId: newRecordId() })
  expect(db().query('SELECT project_id FROM doc WHERE id=?').get(created.id)).toEqual({
    project_id: project.id,
  })

  db().query('UPDATE doc SET project_id=NULL WHERE id=?').run(created.id)
  commitDocRestore({ ...input, revisionId: newRecordId() })
  expect(db().query('SELECT project_id FROM doc WHERE id=?').get(created.id)).toEqual({
    project_id: project.id,
  })
})
