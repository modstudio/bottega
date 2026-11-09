import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db, sessionId } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import type { HostedTaskFlow } from '../record/record-task-flow-contract.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { readThroughTaskFlow } from './task-flow-read-through.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerFixtureWorkflowProject as registerFixtureProject,
  runWorkflowCommand as workflowCommand,
  workflowRecordedArtifact,
} from './workflow-store.fixture.ts'

let priorSession: string | undefined
const previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'workflow-command-positionals'
})

afterEach(() => {
  installRecordApiClient(createMemoryRecordApiClient())
  if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('next by cursor alone reads through the row key and links the hosted task', async () => {
  const slug = 'cursor-command-hosted-takeover'
  const project = 'cursor-command-hosted-takeover-project'
  const key = 'DEV-2174-fixture'
  const taskId = newRecordId()
  const flowId = newRecordId()
  const stageId = newRecordId()
  const remoteMachine = newRecordId()
  const steps = ['diagnose', 'fix-defect-fix']
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/fixture/${project}`,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { kind: 'hub', protocol: 'hub' },
    },
  })
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps }])
  const projectId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(project)!.record_id
  const hosted = (revision: number, ordinal: number): HostedTaskFlow => ({
    flow: {
      id: flowId,
      projectId,
      taskId,
      state: 'open',
      openStageRecordId: stageId,
      openingMachineId: remoteMachine,
      updatedMachineId: remoteMachine,
      revision,
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: '2026-11-07T11:00:00.000Z',
    },
    stage: {
      id: stageId,
      flowRecordId: flowId,
      workflow: slug,
      mode: 'default',
      workflowVersionId: workflowVersionRecordId(db(), slug),
      catalogueVersionId: catalogueVersionRecordId(db()),
      arguments: { key },
      activeOrdinal: ordinal,
      activeSlug: steps[ordinal]!,
      state: 'running',
      closedStepNotes:
        ordinal === 0
          ? []
          : [
              {
                n: 1,
                slug: steps[0]!,
                note: 'diagnosed remotely',
                at: '2026-11-07T10:30:00.000Z',
              },
            ],
      totalSteps: steps.length,
      openedMachineId: remoteMachine,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: remoteMachine,
      revision,
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: '2026-11-07T11:00:00.000Z',
      holder: { id: remoteMachine, displayName: 'Remote CLI machine' },
    },
  })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    readTaskFlow: async () => hosted(1, 0),
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  await readThroughTaskFlow(db(), { taskKey: key, taskRecordId: taskId })
  db().query('UPDATE workflow_cursor SET task_record_id=NULL WHERE record_id=?').run(stageId)
  const cursor = db()
    .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
    .get(stageId)!.number
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    readTaskFlow: async () => hosted(2, 1),
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  const lines: string[] = []
  await workflowCommand(
    [
      'workflow',
      'next',
      '--cursor',
      String(cursor),
      '--note',
      'closed hosted step',
      ...workflowRecordedArtifact(project),
    ],
    presentation(lines),
    {
      json: true,
      hubTaskReader: async () => [{ key, record_id: taskId, project }],
    },
  )

  expect(lines.join('\n')).toContain('Took over this workflow stage from Remote CLI machine.')
  expect(
    db()
      .query('SELECT ordinal,state,task_record_id FROM workflow_cursor WHERE record_id=?')
      .get(stageId),
  ).toEqual({ ordinal: 1, state: 'done', task_record_id: taskId })
})

test('cursor verbs parse every documented positional form before flags', async () => {
  const slug = 'cursor-command-positionals'
  const project = 'cursor-command-positionals-project'
  const key = 'DEV-1880-fixture'
  const catalogue = productionStepCatalogue().definition.steps
  const currentStep = catalogue.find(({ slug }) => slug === 'blast-radius')!.slug
  const nextStep = catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug
  const steps = [currentStep, nextStep]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps }])
  const opened = composeWorkflowWithCursor(
    slug,
    project,
    'default',
    { key },
    { session: sessionId() },
    undefined,
    {},
    {},
  )
  const openedCursor = opened.cursor!.id
  const stored = db()
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(openedCursor)!
  const cursor = 950
  db().query('UPDATE workflow_cursor SET number=? WHERE record_id=?').run(cursor, stored.record_id)
  const rows = [
    { verb: 'step', argv: ['--cursor', String(cursor)], result: 'step' },
    { verb: 'step', argv: [slug, '--cursor', String(cursor)], result: 'step' },
    { verb: 'step', argv: ['--cursor', String(cursor), currentStep], result: 'step' },
    { verb: 'step', argv: [slug, currentStep, '--cursor', String(cursor)], result: 'step' },
    {
      verb: 'step',
      argv: [slug, currentStep, '--project', project, '--arg', `key=${key}`],
      result: 'step',
    },
    {
      verb: 'next',
      argv: ['--cursor', String(cursor), '--note', 'fixture complete'],
      result: 'next',
    },
    {
      verb: 'next',
      argv: [slug, '--cursor', String(cursor), '--note', 'fixture complete'],
      result: 'next',
    },
    {
      verb: 'await',
      argv: ['--cursor', String(cursor), '--question', 'What is the ruling?'],
      result: 'await',
    },
    {
      verb: 'await',
      argv: [slug, '--cursor', String(cursor), '--question', 'What is the ruling?'],
      result: 'await',
    },
    { verb: 'attach', argv: ['--cursor', String(cursor)], result: 'attach' },
    { verb: 'attach', argv: [slug, '--cursor', String(cursor)], result: 'attach' },
  ] as const

  const failures: string[] = []
  for (const row of rows) {
    db()
      .query(
        "UPDATE workflow_cursor SET ordinal=0,step_slug=?,state='running',closed='[]',question=NULL,enforcement='note-only' WHERE number=?",
      )
      .run(currentStep, cursor)
    db().query('DELETE FROM workflow_step_text WHERE cursor_record_id=?').run(stored.record_id)
    const lines: string[] = []
    try {
      await workflowCommand(['workflow', row.verb, ...row.argv], presentation(lines), {
        json: true,
        stdinIsTTY: () => false,
        stdinText: async () => 'fixture workflow text',
      })
      if (row.result === 'step') {
        expect((JSON.parse(lines[0]!) as { slug: string }).slug).toBe(currentStep)
      } else if (row.result === 'attach') {
        expect(
          db().query('SELECT cursor_record_id,step_slug FROM workflow_step_text').get(),
        ).toEqual({ cursor_record_id: stored.record_id, step_slug: currentStep })
      } else {
        expect(
          db()
            .query('SELECT workflow_slug,state,ordinal FROM workflow_cursor WHERE number=?')
            .get(cursor),
        ).toEqual({
          workflow_slug: slug,
          state: row.result === 'next' ? 'running' : 'awaiting-ruling',
          ordinal: row.result === 'next' ? 1 : 0,
        })
      }
    } catch (error) {
      failures.push(`${row.verb} ${row.argv.join(' ')}: ${String(error)}`)
    }
  }
  expect(failures).toEqual([])
})
