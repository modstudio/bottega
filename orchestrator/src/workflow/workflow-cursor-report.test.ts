import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { closedTaskAnnotation, cursorsCommand } from './workflow-cursor-report.ts'
import {
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerCurrentWorkflowProject as registerCurrentProject,
} from './workflow-store.fixture.ts'

test('workflow cursors reports a running cursor whose task is closed and its live runs', async () => {
  const slug = 'closed-task-cursor-report'
  const project = 'closed-task-cursor-project'
  const key = 'DEV-2428'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  const opened = await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key },
    { session: 'closed-task-session' },
    undefined,
    {},
    {},
  )
  const runRecordId = newRecordId()
  const cursorRecordId = db()
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(opened.cursor!.id)!.record_id
  db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,
        status,latency_ms,probe,turn,transport,cursor_record_id,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','write','sha','spec',1,
               'head','running',0,0,1,'cli',?,(SELECT record_id FROM project WHERE name=?))`,
    )
    .run(runRecordId, new Date().toISOString(), cursorRecordId, project)
  const options = {
    hubTaskReader: async () => [
      { key, project, record_id: 'task-dev-2428', status_category: 'done' },
    ],
  }

  let rows: unknown = null
  let text = ''
  await cursorsCommand(
    ['workflow', 'cursors', '--project', project],
    (value, line) => {
      rows = value
      text = line ?? ''
    },
    options,
  )

  expect(rows).toEqual([
    expect.objectContaining({
      task_status_category: 'done',
      live_runs: [expect.objectContaining({ record_id: runRecordId })],
    }),
  ])
  expect(text).toContain('CLOSED TASK done')
})

test('workflow cursors treats cancelled tasks as closed', async () => {
  const slug = 'cancelled-task-cursor-report'
  const project = 'cancelled-task-cursor-project'
  const key = 'DEV-2429'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key },
    { session: 'cancelled-task-session' },
    undefined,
    {},
    {},
  )
  let text = ''
  await cursorsCommand(
    ['workflow', 'cursors', '--project', project],
    (_value, line) => {
      text = line ?? ''
    },
    {
      hubTaskReader: async () => [
        { key, project, record_id: 'task-dev-2429', status_category: 'cancelled' },
      ],
    },
  )
  expect(text).toContain('CLOSED TASK dropped')
})

test('workflow cursors keeps the local listing and warns when task enrichment fails', async () => {
  const slug = 'unavailable-task-cursor-report'
  const project = 'unavailable-task-cursor-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key: 'DEV-2430' },
    { session: 'unavailable-task-session' },
    undefined,
    {},
    {},
  )
  let text = ''
  await cursorsCommand(
    ['workflow', 'cursors', '--project', project],
    (_value, line) => {
      text = line ?? ''
    },
    { hubTaskReader: async () => Promise.reject(new Error('hub unavailable')) },
  )
  expect(text).toContain('unavailable-task-cursor-report')
  expect(text).toContain(
    `warning: could not read task data for project ${project}: hub unavailable`,
  )
  expect(text).toContain('retry:')
  expect(text).toContain(`${PLATFORM_SLUG}`)
  expect(text).toContain(['task', 'list', '--project', project, '--json'].join(' '))
})

test('workflow cursors JSON does not read task data from hub', async () => {
  const slug = 'json-local-cursor-report'
  const project = 'json-local-cursor-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key: 'DEV-2431' },
    { session: 'json-local-session' },
    undefined,
    {},
    {},
  )
  let rows: unknown = null
  await cursorsCommand(
    ['workflow', 'cursors', '--project', project, '--json'],
    (value) => {
      rows = value
    },
    {
      hubTaskReader: async () => {
        throw new Error('must not read hub tasks for JSON')
      },
    },
  )
  expect(rows).toEqual([expect.objectContaining({ workflow_slug: slug })])
})

test('a finished or abandoned cursor on a closed task is not reported as outliving it', () => {
  expect(closedTaskAnnotation('running', 'done')).toBe('CLOSED TASK done')
  expect(closedTaskAnnotation('awaiting-ruling', 'cancelled')).toBe('CLOSED TASK dropped')
  expect(closedTaskAnnotation('done', 'done')).toBeNull()
  expect(closedTaskAnnotation('abandoned', 'dropped')).toBeNull()
})
