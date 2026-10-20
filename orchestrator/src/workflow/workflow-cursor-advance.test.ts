import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const context = { session: 'flow-session' }
const args = { key: 'DEV-1422' }
const testPorts = {
  readTask: (key: string) => ({
    key,
    status: 'done' as const,
    statusCategory: 'done' as const,
    commentIds: [],
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => ({ project: 'fixture', branch: 'work', headIsTipOrAncestor: true }),
  viewPullRequest: () => ({ state: 'MERGED', mergedAt: '2026-10-20' }),
  resolveTreeCommit: () => 'abc',
}

function database(): Database {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}

function installConditionalFixture(
  d: Database,
  slug: string,
  conditionalSteps: string[],
  tail: string[] = ['complete'],
): void {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        {
          slug: 'flow-choice',
          title: 'Choose the flow',
          stage: 'review',
          body: 'Choose the recorded outcome.',
          floor: ['recorded-artifact'],
          outcomes: ['needed', 'clear'],
          job: null,
          autonomy: 'auto',
          needs: [],
        },
      ],
    },
    'conditional cursor fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish', 'test', d)
  const draft = setWorkflowLocal(
    slug,
    {
      title: 'Conditional fixture',
      description: 'Exercises conditional cursor flow.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: [
            'flow-choice',
            ...conditionalSteps.map((step) => ({
              step,
              when: { step: 'flow-choice', outcome: ['needed'] },
            })),
            ...tail,
          ],
        },
      ],
    },
    'conditional cursor fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish', 'test', d)
}

function closeChoice(d: Database, slug: string, outcome?: string): string {
  const probe = d
    .query<{ id: number }, [string]>(
      `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
       VALUES (?,'["true"]','/tmp','abc',0,'','2026-10-20') RETURNING id`,
    )
    .get(newRecordId())!.id
  return nextWorkflowStep(
    slug,
    'fixture',
    'default',
    args,
    'selected',
    context,
    d,
    { artifact: `probe:${probe}` },
    testPorts,
    undefined,
    undefined,
    outcome,
  )
}

function open(d: Database, slug: string): void {
  composeWorkflowWithCursor(slug, 'fixture', 'default', args, context, d)
}

describe('conditional workflow cursor advance', () => {
  test('a step declaring outcomes refuses a close without one', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-required', ['score'])
    open(d, 'conditional-required')
    expect(() => closeChoice(d, 'conditional-required')).toThrow(
      'requires --outcome <slug>; allowed values: needed, clear',
    )
  })

  test('an unmet condition records a skip and serves the next eligible step', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-skip', ['score'])
    open(d, 'conditional-skip')
    expect(closeChoice(d, 'conditional-skip', 'clear')).toContain(
      'Flow so far: flow-choice=clear, score=skipped',
    )
    const row = d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get() as {
      ordinal: number
      step_slug: string
      closed: string
    }
    expect(row).toMatchObject({ ordinal: 2, step_slug: 'complete' })
    expect(JSON.parse(row.closed)).toEqual([
      expect.objectContaining({ slug: 'flow-choice', outcome: 'clear' }),
      expect.objectContaining({
        slug: 'score',
        skipped: { step: 'flow-choice', outcome: ['needed'] },
      }),
    ])
    expect(
      getWorkflowStepWithCursor('conditional-skip', 'fixture', 'score', args, 'default', context, d)
        .slug,
    ).toBe('complete')
  })

  test('a met condition serves the conditional step', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-met', ['score'])
    open(d, 'conditional-met')
    expect(closeChoice(d, 'conditional-met', 'needed')).toContain('Score every lens.')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 1,
      step_slug: 'score',
    })
  })

  test('a chain of two unmet conditions skips both', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-chain', ['score', 'ship-triage'])
    open(d, 'conditional-chain')
    closeChoice(d, 'conditional-chain', 'clear')
    const row = d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get() as {
      ordinal: number
      step_slug: string
      closed: string
    }
    expect(row).toMatchObject({ ordinal: 3, step_slug: 'complete' })
    expect(
      JSON.parse(row.closed).filter((entry: { skipped?: unknown }) => entry.skipped),
    ).toHaveLength(2)
  })

  test('skipping conditional steps off the end finishes the cursor', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-end', ['score'], [])
    open(d, 'conditional-end')
    expect(closeChoice(d, 'conditional-end', 'clear')).toContain('is finished: 2 steps closed')
    expect(d.query('SELECT state FROM workflow_cursor').get()).toEqual({ state: 'done' })
  })
})
