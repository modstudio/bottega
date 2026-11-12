import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { cliWorkflowCursorContext } from './workflow-cursor-selection.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerFixtureWorkflowProject as registerFixtureProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('next without a cursor flag writes the selected cursor number', async () => {
  const slug = 'cursor-context-number'
  const project = 'cursor-context-number-project'
  const key = 'DEV-2267-NUMBER'
  const catalogue = productionStepCatalogue().definition.steps
  const steps = [
    catalogue.find(({ slug }) => slug === 'blast-radius')!.slug,
    catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug,
  ]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [{ slug: 'report', title: 'Report', default: true, steps }])
  const composed = await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key },
    cliWorkflowCursorContext(),
    undefined,
    {},
    {},
  )
  const cursor = composed.cursor!.id
  db().query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)
  const items = new Map<string, { kind: string; body: string }>()
  const ports = {
    set: async (input) => {
      items.set(input.id, { kind: input.kind, body: input.body })
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
    drop: async (input) => ({
      holder: `task:${input.task}`,
      task: input.task ?? null,
      id: input.id,
      removed: false,
    }),
  } as ContextMomentPorts

  await workflowCommand(
    [
      'workflow',
      'next',
      slug,
      '--project',
      project,
      '--note',
      'advance by identity',
      '--arg',
      `key=${key}`,
    ],
    presentation([]),
    { contextMomentPorts: ports },
  )

  expect(items.get('next')).toEqual({
    kind: 'next-action',
    body: `${slug} cursor ${cursor} at fix-defect-triage: Triage findings`,
  })
})

test('await, operator rule, and next replace task context through command seams', async () => {
  const slug = 'cursor-context-moments'
  const project = 'cursor-context-moments-project'
  const key = 'DEV-2267'
  const currentCatalogue = productionStepCatalogue().definition
  const blastRadius = currentCatalogue.steps.find(({ slug }) => slug === 'blast-radius')!
  const selfRulingStep = {
    ...blastRadius,
    slug: 'context-self-rule',
    title: 'Record the self-ruling',
    floor: ['ruling' as const],
    autonomy: 'auto' as const,
  }
  const draft = setStepCatalogueLocal(
    { ...currentCatalogue, steps: [...currentCatalogue.steps, selfRulingStep] },
    'add context self-ruling fixture',
    'test',
  )
  promoteStepCatalogueLocal(draft.n, 'publish context self-ruling fixture', 'test')
  const catalogue = productionStepCatalogue().definition.steps
  const steps = [
    catalogue.find(({ slug }) => slug === 'blast-radius')!.slug,
    selfRulingStep.slug,
    catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug,
  ]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [{ slug: 'report', title: 'Report', default: true, steps }])
  const composed = await composeWorkflowWithCursor(
    slug,
    project,
    'report',
    { key },
    {},
    undefined,
    {},
    {},
  )
  const cursor = composed.cursor!.id
  db().query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)
  const items = new Map<string, { kind: string; body: string }>()
  const ports = {
    set: async (input) => {
      items.set(input.id, { kind: input.kind, body: input.body })
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
    drop: async (input) => {
      const removed = items.delete(input.id)
      if (!removed) throw new Error(`no context item task:${input.task}/${input.id}`)
      return { holder: `task:${input.task}`, task: input.task ?? null, id: input.id, removed }
    },
  } as ContextMomentPorts
  const lines: string[] = []
  const command = (verb: string, ...tail: string[]) =>
    workflowCommand(
      ['workflow', verb, slug, '--cursor', String(cursor), ...tail],
      presentation(lines),
      { contextMomentPorts: ports },
    )

  await command('await', '--question', 'May this proceed?')
  const openId = [...items.keys()].find((id) => id.startsWith('open-q'))!
  const question = openId.slice('open-q'.length)
  expect(items.get(openId)).toEqual({ kind: 'open-question', body: 'May this proceed?' })

  await command('rule', '--ruling', 'Proceed.', '--from-operator')
  expect(items.has(openId)).toBeFalse()
  expect(items.get(`ruling-q${question}`)).toEqual({ kind: 'ruling', body: 'Proceed.' })

  await command('next', '--note', 'closed after the operator ruling')
  expect(items.get('next')).toEqual({
    kind: 'next-action',
    body: `${slug} cursor ${cursor} at context-self-rule: Record the self-ruling`,
  })

  await command(
    'next',
    '--note',
    'accepted by the specification',
    '--self-ruling',
    '  The acceptance criteria are met.  ',
    '--basis',
    'DEV-2267 acceptance criteria',
  )
  const selfRulingPosition = [...items.entries()].find(
    ([id, item]) => id.startsWith('position-q') && item.body === 'The acceptance criteria are met.',
  )
  expect(selfRulingPosition).toBeDefined()
  expect(items.get('next')).toEqual({
    kind: 'next-action',
    body: `${slug} cursor ${cursor} at fix-defect-triage: Triage findings`,
  })

  await workflowCommand(
    ['workflow', 'next', slug, '--cursor', String(cursor), '--note', 'finished triage'],
    presentation(lines),
    {
      contextMomentPorts: ports,
      contextMomentGather: () => {
        throw new Error('injected gather failure')
      },
    },
  )
  expect(
    db()
      .query<{ state: string }, [number]>('SELECT state FROM workflow_cursor WHERE number=?')
      .get(cursor),
  ).toEqual({ state: 'done' })
  expect(lines).toContain(
    'context: could not gather workflow-next on DEV-2267: injected gather failure',
  )
})
