import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerCurrentWorkflowProject as registerCurrentProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('CLI abandon refuses another sessions cursor until its owner is acknowledged', async () => {
  const project = 'cursor-abandon-owner-project'
  const slug = 'cursor-abandon-owner'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!.slug
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps: [step] }])
  const opened = await composeWorkflowWithCursor(
    slug,
    project,
    'default',
    { key: 'DEV-2365' },
    {},
    undefined,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  db()
    .query('UPDATE workflow_cursor SET session_id=? WHERE number=?')
    .run('foreign-session', cursor)
  const argv = [
    'workflow',
    'abandon',
    '--cursor',
    String(cursor),
    '--project',
    project,
    '--reason',
    'test',
  ]
  await expect(workflowCommand(argv, presentation([]))).rejects.toThrow(
    'owned by session foreign-session; rerun with --owner-session foreign-session',
  )
  await workflowCommand([...argv, '--owner-session', 'foreign-session'], presentation([]))
  expect(db().query('SELECT state FROM workflow_cursor WHERE number=?').get(cursor)).toEqual({
    state: 'abandoned',
  })
})
