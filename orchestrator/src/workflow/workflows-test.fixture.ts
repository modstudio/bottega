import type { Database } from 'bun:sqlite'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { promoteWorkflowLocal, setWorkflowLocal, type WorkflowDefinition } from './workflows.ts'

export const validWorkflow = (): WorkflowDefinition => ({
  title: 'A workflow',
  description: 'Does work.',
  arguments: [
    { name: 'key', required: true, description: 'Task key' },
    { name: 'branch', required: true, description: 'Branch' },
    { name: 'worktree', required: true, description: 'Worktree' },
  ],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['lens'] }],
})

export const releaseFixture = {
  rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
  mergeMethod: 'squash' as const,
  requiredChecks: ['gate'],
  observationWindowHours: 24,
}

export const promotePlanTaskFixture = (d: Database) => {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      steps: [
        ...current.steps,
        {
          slug: 'injection-search',
          stage: 'plan',
          title: 'Search',
          body: 'Search with {{tracker.actions.search}}.',
          floor: ['ruling'],
          job: null,
          autonomy: 'ask',
          needs: ['tracker'],
        },
        {
          slug: 'injection-start',
          stage: 'plan',
          title: 'Start',
          body: 'Move to {{tracker.states.active}} with {{tracker.actions.status}} after {{tracker.actions.get}}.',
          floor: ['tracker-transition'],
          job: null,
          autonomy: 'auto',
          needs: ['tracker'],
        },
      ],
    },
    'workflow injection fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish', 'test', d)
  const draft = setWorkflowLocal(
    'plan-task',
    {
      title: 'Plan a task',
      description: 'Plan.',
      arguments: [{ name: 'key', required: false, description: 'Existing task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Plan',
          default: true,
          steps: ['injection-search', 'injection-start'],
        },
      ],
    },
    'workflow injection fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('plan-task', draft.n, 'publish', 'test', d)
}
