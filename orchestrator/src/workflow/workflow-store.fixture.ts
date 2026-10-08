import type { Database } from 'bun:sqlite'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import { promoteWorkflow, setWorkflow } from './workflows.ts'

/** Installs a neutral multi-step workflow for tests of generic workflow behavior. */
export function installWorkflowStoreFixture(d: Database): void {
  const current = productionStepCatalogue(d).definition
  const steps = [
    {
      slug: 'rebase',
      title: 'Rebase and verify',
      stage: 'ship' as const,
      body: 'Run `{{gate}}` in `{{worktree}}` after rebasing on origin/{{trunk}}.',
      floor: ['command-exit' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: ['gate', 'trunk'],
    },
    {
      slug: 'lens',
      title: 'Run independent review lenses',
      stage: 'review' as const,
      body: 'Review {{branch}} for {{key}}.',
      floor: ['recorded-artifact' as const],
      job: 'review-lens',
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'score',
      title: 'Score the lenses',
      stage: 'review' as const,
      body: 'Score every lens.',
      floor: ['recorded-artifact' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'ship-triage',
      title: 'Triage every finding',
      stage: 'review' as const,
      body: 'Triage every finding.',
      floor: ['ruling' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'complete',
      title: 'Complete the review',
      stage: 'review' as const,
      body: 'Complete the review.',
      floor: ['recorded-artifact' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'ship-fix',
      title: 'Fix accepted findings',
      stage: 'review' as const,
      body: 'Fix accepted findings.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: 'implement',
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'pr',
      title: 'Open the pull request',
      stage: 'ship' as const,
      body: 'Open the pull request against {{trunk}}.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: ['trunk'],
    },
    {
      slug: 'merge',
      title: 'Merge and pull',
      stage: 'ship' as const,
      body: 'Merge the pull request.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'close',
      title: 'Close the task',
      stage: 'ship' as const,
      body: 'Close the task.',
      floor: ['tracker-transition' as const],
      expectedStatus: '{{tracker.states.done}}',
      requirePullRequest: true,
      job: null,
      autonomy: 'auto' as const,
      needs: ['tracker'],
    },
  ]
  const catalogue = setStepCatalogue(
    { ...current, steps: [...current.steps, ...steps] },
    'neutral workflow test fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish neutral workflow test fixture', 'test', d)
  const workflow = setWorkflow(
    'flow',
    {
      title: 'Fixture workflow',
      description: 'Exercises generic workflow behavior.',
      arguments: [
        { name: 'key', required: true, description: 'The task key.' },
        { name: 'branch', required: true, description: 'The branch.' },
        { name: 'worktree', required: true, rebind: true, description: 'The worktree path.' },
      ],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: [
            'rebase',
            'lens',
            'score',
            'ship-triage',
            'complete',
            'ship-fix',
            'pr',
            'merge',
            'close',
          ],
        },
      ],
    },
    'neutral workflow test fixture',
    'test',
    d,
  )
  promoteWorkflow('flow', workflow.n, 'publish neutral workflow test fixture', 'test', d)
}
