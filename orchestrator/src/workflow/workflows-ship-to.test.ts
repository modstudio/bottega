import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { composeWorkflow, getWorkflowStep, promoteWorkflow, setWorkflow } from './workflows.ts'

const release = {
  rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
  mergeMethod: 'squash' as const,
  requiredChecks: ['gate'],
  observationWindowHours: 24,
}

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
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}

const publishShipToFixture = (
  d: Database,
  needs: string[] = ['tracker', 'ship-to'],
  floor?: string,
) => {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogue(
    {
      steps: [
        ...current.steps,
        {
          slug: 'ship-to-fixture',
          stage: 'ship',
          title: 'Ship-to fixture',
          body: needs.includes('tracker')
            ? 'Close at {{shipTo.closeState}} with {{shipTo.remainingText}} remaining.'
            : 'Ship to {{shipTo.level}}.',
          ...(needs.includes('tracker') ? { expectedStatus: '{{shipTo.closeState}}' } : {}),
          floor: [
            floor ?? (needs.includes('tracker') ? '{{shipTo.closeFloor}}' : 'tracker-transition'),
          ],
          ...(needs.includes('tracker') ? { operatorRuling: true } : {}),
          job: null,
          autonomy: 'auto',
          needs,
        },
      ],
    },
    'ship-to fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
  const workflow = setWorkflow(
    'ship-to-fixture',
    {
      title: 'Ship-to fixture',
      description: 'Ship.',
      arguments: [{ name: 'depth', required: false, description: 'Last rung.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['ship-to-fixture'],
        },
      ],
    },
    'ship-to fixture',
    'test',
    d,
  )
  promoteWorkflow('ship-to-fixture', workflow.n, 'publish', 'test', d)
}

const shipToAutonomy = (level: 'branch' | 'trunk' | 'production') => ({
  steps: { 'ship-to-fixture': { value: 'auto' as const, scope: 'test' } },
  rulings: { value: 'agent' as const, scope: 'test' },
  shipTo: { value: level, scope: 'session' },
})

describe('ship-to workflow composition', () => {
  test.each([
    ['trunk', [{ name: 'production', branch: 'production' }], 'review', 'review'],
    ['trunk', [], 'done', 'done'],
    ['production', [{ name: 'production', branch: 'production' }], 'done', 'done'],
  ] as const)('ship-to %s resolves close action and state', (level, rungs, action, state) => {
    const d = database()
    publishShipToFixture(d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'hub' },
        release: { rungs, mergeMethod: 'squash', requiredChecks: [] },
        docs: { protocol: 'orch-docs' },
      }),
      'fixture',
    )
    const autonomy = shipToAutonomy(level)
    const composed = composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, autonomy)
    const served = getWorkflowStep(
      'ship-to-fixture',
      'fixture',
      'ship-to-fixture',
      {},
      d,
      {},
      autonomy,
    )

    expect(composed.facts.shipTo).toMatchObject({
      closeAction: action,
      closeFloor: 'tracker-transition',
      closeState: state,
    })
    expect(composed.steps[0]!.floor).toEqual(['tracker-transition'])
    expect(composed.steps[0]!.expectedStatus).toBe(state)
    expect(served.facts.shipTo).toMatchObject({
      closeAction: action,
      closeFloor: 'tracker-transition',
      closeState: state,
    })
    expect(served.floor).toEqual(['tracker-transition'])
    expect(served.expectedStatus).toBe(state)
  })

  test('a project with a remaining rung and no review state composes and asks', () => {
    const d = database()
    publishShipToFixture(d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'workspace-mcp', states: { completed: 'done' } },
        release,
        docs: { protocol: 'orch-docs' },
      }),
      'fixture',
    )
    const autonomy = shipToAutonomy('trunk')
    const composed = composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, autonomy)
    const served = getWorkflowStep(
      'ship-to-fixture',
      'fixture',
      'ship-to-fixture',
      {},
      d,
      {},
      autonomy,
    )

    expect(composed.facts.shipTo).toMatchObject({
      closeAction: 'ask',
      closeFloor: 'ruling',
      closeState: 'none',
    })
    expect(composed.steps[0]!.floor).toEqual(['ruling'])
    expect(composed.steps[0]!.expectedStatus).toBe('none')
    expect(served.facts.shipTo).toMatchObject({
      closeAction: 'ask',
      closeFloor: 'ruling',
      closeState: 'none',
    })
    expect(served.floor).toEqual(['ruling'])
    expect(served.expectedStatus).toBe('none')
  })

  test('a placeholder floor resolving to a non-kind refuses compose and step fetch', () => {
    const d = database()
    publishShipToFixture(d, ['tracker', 'ship-to'], '{{shipTo.closeState}}')
    const autonomy = shipToAutonomy('trunk')
    const expected =
      'step "ship-to-fixture" floor placeholder "{{shipTo.closeState}}" resolved to invalid floor kind "done"'

    expect(() =>
      composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, autonomy),
    ).toThrow(expected)
    expect(() =>
      getWorkflowStep('ship-to-fixture', 'fixture', 'ship-to-fixture', {}, d, {}, autonomy),
    ).toThrow(expected)
  })

  test('a close action of done refuses a tracker with no done state', () => {
    const d = database()
    publishShipToFixture(d)
    d.query('UPDATE project SET settings=? WHERE name=?').run(
      JSON.stringify({
        tracker: { protocol: 'workspace-mcp', states: { checking: 'review' } },
        release: { ...release, rungs: [] },
        docs: { protocol: 'orch-docs' },
      }),
      'fixture',
    )
    const autonomy = shipToAutonomy('trunk')
    const expected =
      'project fixture tracker is missing workflow state "done"; set it with: orch project set fixture --settings'

    expect(() =>
      composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, autonomy),
    ).toThrow(expected)
    expect(() =>
      getWorkflowStep('ship-to-fixture', 'fixture', 'ship-to-fixture', {}, d, {}, autonomy),
    ).toThrow(expected)
  })

  test('a project without release settings composes a step needing ship-to', () => {
    const d = database()
    publishShipToFixture(d, ['ship-to'])

    expect(
      composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, shipToAutonomy('trunk'))
        .facts.shipTo,
    ).toEqual({
      level: 'trunk',
      scope: 'session',
      mayMerge: 'yes',
      reach: [],
      remaining: [],
      reachText: 'none',
      remainingText: 'none',
    })
  })

  test('compose and step fetch refuse ship-to facts when the hosted level is incomplete', () => {
    const d = database()
    publishShipToFixture(d, ['ship-to'])
    const autonomy = {
      ...shipToAutonomy('trunk'),
      shipTo: {
        value: 'trunk' as const,
        scope: 'built-in',
        complete: false,
        unavailableReason: 'record service offline',
      },
    }
    const expected =
      'hosted autonomy settings could not be read: record service offline; retry when the hosted record is reachable, or set the level for this machine with orch config set --machine autonomy.ship-to <level>'

    expect(() =>
      composeWorkflow('ship-to-fixture', 'fixture', undefined, {}, d, {}, autonomy),
    ).toThrow(expected)
    expect(() =>
      getWorkflowStep('ship-to-fixture', 'fixture', 'ship-to-fixture', {}, d, {}, autonomy),
    ).toThrow(expected)
  })
})
