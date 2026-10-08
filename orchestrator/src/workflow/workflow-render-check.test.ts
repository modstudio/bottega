import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import type { Project } from '../project/projects.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  type StepCatalogueDefinition,
  setStepCatalogue,
} from './step-catalogue.ts'
import {
  checkWorkflowRendering,
  unresolvedWorkflowStepPlaceholders,
} from './workflow-render-check.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { promoteWorkflow, setWorkflow, type WorkflowDefinition } from './workflows.ts'

const workflow = (step: string): WorkflowDefinition => ({
  title: 'Render check',
  description: 'Checks rendering.',
  arguments: [{ name: 'key', required: true, description: 'Task key.' }],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: [step] }],
})

const catalogue = (body: string, needs: ['tracker'] = ['tracker']): StepCatalogueDefinition => ({
  steps: [
    {
      slug: 'check',
      title: 'Check',
      body,
      floor: ['recorded-artifact'],
      job: null,
      stage: 'review',
      autonomy: 'auto',
      needs,
    },
  ],
})

const project = (settings: Project['settings']): Project => ({
  id: 1,
  name: 'fixture',
  path: '/fixture',
  stack: 'bun',
  canon: false,
  retiredAt: null,
  settings,
})

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ tracker: { protocol: 'hub' } }),
  )
  return d
}

describe('workflow render check', () => {
  test('reports an optional-fact placeholder only when the resolved project lacks it', () => {
    const definition = workflow('check')
    const missing = unresolvedWorkflowStepPlaceholders(
      'render-check',
      definition,
      catalogue('Use {{tracker.server}}.'),
      {
        project: 'fixture',
        arguments: { key: 'DEV-1' },
        facts: { tracker: { protocol: 'hub' } },
      },
    )
    const present = unresolvedWorkflowStepPlaceholders(
      'render-check',
      definition,
      catalogue('Use {{tracker.server}}.'),
      {
        project: 'fixture',
        arguments: { key: 'DEV-1' },
        facts: { tracker: { protocol: 'workspace-mcp', server: 'fixture' } },
      },
    )

    expect(missing).toEqual([
      {
        project: 'fixture',
        workflow: 'render-check',
        mode: 'default',
        step: 'check',
        placeholder: 'tracker.server',
      },
    ])
    expect(present).toEqual([])
  })

  test('reports a project whose required facts cannot resolve once instead of counting it clean', () => {
    const result = checkWorkflowRendering(
      [
        { slug: 'first', definition: workflow('check') },
        { slug: 'second', definition: workflow('check') },
      ],
      catalogue('Use {{tracker.protocol}}.'),
      [project({})],
    )

    expect(result.failures).toEqual([])
    expect(result.unresolvedProjects).toEqual([
      {
        project: 'fixture',
        workflows: ['first', 'second'],
        facts: [
          `tracker; set with: orch project set fixture --settings '{"tracker":{"protocol":"<protocol>"}}'`,
        ],
      },
    ])
  })

  test('catalogue and workflow promotion refuse an unrenderable candidate with the remedy', () => {
    const catalogueDatabase = database()
    const current = productionStepCatalogue(catalogueDatabase).definition
    const safeCatalogue = setStepCatalogue(
      { steps: [...current.steps, ...catalogue('Read the tracker facts.').steps] },
      'add safe render step',
      'test',
      catalogueDatabase,
    )
    promoteStepCatalogue(safeCatalogue.n, 'publish safe render step', 'test', catalogueDatabase)
    const safeWorkflow = setWorkflow(
      'catalogue-render-guard',
      workflow('check'),
      'add render workflow',
      'test',
      catalogueDatabase,
    )
    promoteWorkflow(
      'catalogue-render-guard',
      safeWorkflow.n,
      'publish render workflow',
      'test',
      catalogueDatabase,
    )
    const badCatalogue = setStepCatalogue(
      {
        steps: productionStepCatalogue(catalogueDatabase).definition.steps.map((step) =>
          step.slug === 'check' ? { ...step, body: 'Use {{tracker.server}}.' } : step,
        ),
      },
      'make render step unrenderable',
      'test',
      catalogueDatabase,
    )

    expect(() =>
      promoteStepCatalogue(badCatalogue.n, 'publish unrenderable step', 'test', catalogueDatabase),
    ).toThrow(
      'project fixture, workflow catalogue-render-guard, mode default, step check, placeholder tracker.server',
    )
    expect(() =>
      promoteStepCatalogue(badCatalogue.n, 'publish unrenderable step', 'test', catalogueDatabase),
    ).toThrow("fix the step body or the project's register entry")

    const workflowDatabase = database()
    const catalogueWithBadStep = setStepCatalogue(
      {
        steps: [
          ...productionStepCatalogue(workflowDatabase).definition.steps,
          ...catalogue('Use {{tracker.server}}.').steps,
        ],
      },
      'add unreferenced render step',
      'test',
      workflowDatabase,
    )
    promoteStepCatalogue(
      catalogueWithBadStep.n,
      'publish unreferenced render step',
      'test',
      workflowDatabase,
    )
    const badWorkflow = setWorkflow(
      'workflow-render-guard',
      workflow('check'),
      'add unrenderable workflow',
      'test',
      workflowDatabase,
    )

    expect(() =>
      promoteWorkflow(
        'workflow-render-guard',
        badWorkflow.n,
        'publish unrenderable workflow',
        'test',
        workflowDatabase,
      ),
    ).toThrow(
      'project fixture, workflow workflow-render-guard, mode default, step check, placeholder tracker.server',
    )
    expect(() =>
      promoteWorkflow(
        'workflow-render-guard',
        badWorkflow.n,
        'publish unrenderable workflow',
        'test',
        workflowDatabase,
      ),
    ).toThrow("fix the step body or the project's register entry")
  })
})
