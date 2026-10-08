import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import type { WorkflowFactSource } from '../project/project-injection.ts'
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

const catalogue = (
  body: string,
  needs: WorkflowFactSource[] = ['tracker'],
): StepCatalogueDefinition => ({
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
    JSON.stringify({
      tracker: { protocol: 'hub' },
      docs: { protocol: 'orch-docs' },
      gate: 'true',
      trunk: 'main',
      release: { rungs: [], mergeMethod: 'squash', requiredChecks: [] },
    }),
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
        field: 'body',
        placeholder: 'tracker.server',
      },
    ])
    expect(present).toEqual([])
  })

  test('reports an unrenderable step reached only through a sequence', () => {
    const definition = workflow('check')
    definition.modes[0]!.steps = [{ sequence: 'checks' }]
    const sequencedCatalogue = catalogue('Use {{tracker.server}}.')
    sequencedCatalogue.sequences = [{ slug: 'checks', title: 'Checks', steps: ['check'] }]

    const result = checkWorkflowRendering([{ slug: 'sequenced', definition }], sequencedCatalogue, [
      project({ tracker: { protocol: 'hub' } }),
    ])

    expect(result.failures).toEqual([
      {
        project: 'fixture',
        workflow: 'sequenced',
        mode: 'default',
        step: 'check',
        field: 'body',
        placeholder: 'tracker.server',
      },
    ])
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
    expect(result.resolutionFailures).toEqual([])
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

  test('resolves each step from only that step declared needs', () => {
    const definition: WorkflowDefinition = {
      ...workflow('undeclared'),
      modes: [
        { slug: 'first', title: 'First', default: true, steps: ['undeclared'] },
        { slug: 'second', title: 'Second', steps: ['declared'] },
      ],
    }
    const definitionCatalogue: StepCatalogueDefinition = {
      steps: [
        { ...catalogue('Use {{tracker.protocol}}.', []).steps[0]!, slug: 'undeclared' },
        { ...catalogue('Tracker is declared.').steps[0]!, slug: 'declared' },
      ],
    }

    const result = checkWorkflowRendering([{ slug: 'per-step', definition }], definitionCatalogue, [
      project({ tracker: { protocol: 'hub' } }),
    ])

    expect(result.failures).toEqual([
      {
        project: 'fixture',
        workflow: 'per-step',
        mode: 'first',
        step: 'undeclared',
        field: 'body',
        placeholder: 'tracker.protocol',
      },
    ])
    expect(result.unresolvedProjects).toEqual([])
    expect(result.resolutionFailures).toEqual([])
  })

  test('reports a non-missing-fact refusal under its own wording', () => {
    const result = checkWorkflowRendering(
      [{ slug: 'invalid-tracker', definition: workflow('check') }],
      catalogue('Use {{tracker.protocol}}.'),
      [project({ tracker: { protocol: 'unsupported' as 'hub' } })],
    )

    expect(result.unresolvedProjects).toEqual([])
    expect(result.resolutionFailures).toEqual([
      {
        project: 'fixture',
        workflow: 'invalid-tracker',
        mode: 'default',
        step: 'check',
        reason:
          'tracker protocol unsupported has no workflow injection support; set tracker.protocol to one of workspace-mcp, cursor-mcp, array-mcp, hub',
      },
    ])
  })

  test('reports a floor placeholder that resolves to an invalid floor kind', () => {
    const badFloor = catalogue('Body renders.')
    badFloor.steps[0]!.floor = ['{{tracker.server}}']
    const result = checkWorkflowRendering(
      [{ slug: 'invalid-floor', definition: workflow('check') }],
      badFloor,
      [project({ tracker: { protocol: 'workspace-mcp' } })],
    )

    expect(result.failures).toEqual([
      {
        project: 'fixture',
        workflow: 'invalid-floor',
        mode: 'default',
        step: 'check',
        field: 'floor',
        placeholder: 'tracker.server',
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
      'project fixture, workflow catalogue-render-guard, mode default, step check, field body, placeholder tracker.server',
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
      'project fixture, workflow workflow-render-guard, mode default, step check, field body, placeholder tracker.server',
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

  for (const [field, changedStep] of [
    ['floor', { floor: ['{{tracker.server}}'] }],
    ['expectedStatus', { expectedStatus: '{{tracker.server}}' }],
  ] as const) {
    test(`both promotion guards refuse an unrenderable ${field}`, () => {
      const catalogueDatabase = database()
      const current = productionStepCatalogue(catalogueDatabase).definition
      const safeCatalogue = setStepCatalogue(
        { steps: [...current.steps, ...catalogue('Body renders.').steps] },
        'add safe field render step',
        'test',
        catalogueDatabase,
      )
      promoteStepCatalogue(
        safeCatalogue.n,
        'publish safe field render step',
        'test',
        catalogueDatabase,
      )
      const safeWorkflow = setWorkflow(
        'catalogue-field-render-guard',
        workflow('check'),
        'add field render workflow',
        'test',
        catalogueDatabase,
      )
      promoteWorkflow(
        'catalogue-field-render-guard',
        safeWorkflow.n,
        'publish field render workflow',
        'test',
        catalogueDatabase,
      )
      const badCatalogue = setStepCatalogue(
        {
          steps: productionStepCatalogue(catalogueDatabase).definition.steps.map((step) =>
            step.slug === 'check' ? { ...step, ...changedStep } : step,
          ),
        },
        'make field unrenderable',
        'test',
        catalogueDatabase,
      )

      expect(() =>
        promoteStepCatalogue(badCatalogue.n, 'publish bad field', 'test', catalogueDatabase),
      ).toThrow(
        `project fixture, workflow catalogue-field-render-guard, mode default, step check, field ${field}, placeholder tracker.server`,
      )
      expect(() =>
        promoteStepCatalogue(badCatalogue.n, 'publish bad field', 'test', catalogueDatabase),
      ).toThrow("fix the step body or the project's register entry")

      const workflowDatabase = database()
      const badStep = { ...catalogue('Body renders.').steps[0]!, ...changedStep }
      const catalogueWithBadStep = setStepCatalogue(
        {
          steps: [...productionStepCatalogue(workflowDatabase).definition.steps, badStep],
        },
        'add unreferenced bad field step',
        'test',
        workflowDatabase,
      )
      promoteStepCatalogue(
        catalogueWithBadStep.n,
        'publish unreferenced bad field step',
        'test',
        workflowDatabase,
      )
      const badWorkflow = setWorkflow(
        'workflow-field-render-guard',
        workflow('check'),
        'add bad field workflow',
        'test',
        workflowDatabase,
      )

      expect(() =>
        promoteWorkflow(
          'workflow-field-render-guard',
          badWorkflow.n,
          'publish bad field workflow',
          'test',
          workflowDatabase,
        ),
      ).toThrow(
        `project fixture, workflow workflow-field-render-guard, mode default, step check, field ${field}, placeholder tracker.server`,
      )
      expect(() =>
        promoteWorkflow(
          'workflow-field-render-guard',
          badWorkflow.n,
          'publish bad field workflow',
          'test',
          workflowDatabase,
        ),
      ).toThrow("fix the step body or the project's register entry")
    })
  }
})
