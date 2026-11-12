import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerFixtureWorkflowProject as registerFixtureProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('workflow writing verbs enforce record shapes at the command edge', async () => {
  const cases = [
    {
      argv: ['workflow', 'next', 'fixture', '--note', 'x'.repeat(301)],
      message: 'step note is 301 characters; the limit is 300 (STEP_NOTE_MAX_CHARS)',
    },
    {
      argv: ['workflow', 'next', 'fixture', '--self-ruling', 'x'.repeat(801)],
      message: 'self-ruling is 801 characters; the limit is 800 (SELF_RULING_MAX_CHARS)',
    },
    {
      argv: [
        'workflow',
        'next',
        'fixture',
        '--self-ruling',
        'Proceed.',
        '--basis',
        'x'.repeat(801),
      ],
      message: 'basis is 801 characters; the limit is 800 (BASIS_MAX_CHARS)',
    },
    {
      argv: ['workflow', 'await', 'fixture', '--question', 'x'.repeat(801)],
      message: 'open question is 801 characters; the limit is 800 (OPEN_QUESTION_MAX_CHARS)',
    },
    {
      argv: ['workflow', 'rule', 'fixture', '--ruling', 'x'.repeat(1501)],
      message: 'ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)',
    },
  ]
  for (const { argv, message } of cases) {
    await expect(workflowCommand(argv, presentation([]))).rejects.toThrow(message)
  }
})

test('a refused step note leaves the cursor unchanged', async () => {
  const slug = 'cursor-note-shape'
  const project = 'cursor-note-shape-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  const opened = await composeWorkflowWithCursor(
    slug,
    project,
    undefined,
    { key: 'DEV-2266' },
    {},
    undefined,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  const before = db().query('SELECT ordinal,state FROM workflow_cursor WHERE number=?').get(cursor)

  for (const note of ['first\nsecond', 'x'.repeat(301)]) {
    await expect(
      workflowCommand(
        ['workflow', 'next', '--cursor', String(cursor), '--note', note],
        presentation([]),
      ),
    ).rejects.toThrow('step note')
    expect(
      db().query('SELECT ordinal,state FROM workflow_cursor WHERE number=?').get(cursor),
    ).toEqual(before)
  }
})
