import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursor,
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
} from './workflow-cursor.ts'
import { mapStoredAutonomyResolution } from './workflow-cursor-autonomy.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { composeWorkflow } from './workflows.ts'

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one' }

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run(
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

function installShipToFlow(d: Database): void {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogue(
    {
      steps: current.steps.map((step) =>
        step.slug === 'rebase'
          ? { ...step, body: 'Ship to {{shipTo.level}}.', needs: [...step.needs, 'ship-to'] }
          : step,
      ),
    },
    'ship-to cursor fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish ship-to cursor fixture', 'test', d)
}

function replaceCursorAutonomy(
  d: Database,
  change: (stored: Record<string, unknown>) => void,
): void {
  const row = d.query('SELECT autonomy FROM workflow_cursor').get() as { autonomy: string }
  const stored = JSON.parse(row.autonomy) as Record<string, unknown>
  change(stored)
  d.query('UPDATE workflow_cursor SET autonomy=?').run(JSON.stringify(stored))
}

function composeShipToFlow(d: Database) {
  const composed = composeWorkflow('flow', 'fixture', 'default', args, d)
  return composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {
      steps: Object.fromEntries(composed.steps.map((step) => [step.slug, step.resolvedAutonomy])),
      rulings: composed.rulings,
      shipTo: { value: 'trunk', scope: 'test' },
    },
  )
}

describe('workflow cursor stored autonomy', () => {
  test('maps a legacy release resolution to ship-to', () => {
    const stored = {
      steps: {},
      rulings: { value: 'agent' as const, scope: 'test' },
      release: { value: 'push', scope: 'legacy project' },
    }

    expect(mapStoredAutonomyResolution(stored).shipTo).toEqual({
      value: 'branch',
      scope: 'legacy project',
    })
  })

  test('leaves ship-to absent when a stored snapshot has no usable level', () => {
    const stored = {
      steps: {},
      rulings: { value: 'agent' as const, scope: 'test' },
    }

    expect(mapStoredAutonomyResolution(stored).shipTo).toBeUndefined()
  })

  test('step fetch refuses an abandoned cursor without composing its old autonomy', () => {
    const d = database()
    installShipToFlow(d)
    composeShipToFlow(d)
    abandonWorkflowCursor('flow', 'fixture', 'default', args, 'operator stopped', context, d)
    replaceCursorAutonomy(d, (stored) => {
      delete stored.shipTo
    })

    expect(() =>
      getWorkflowStepWithCursor('flow', 'fixture', 'lens', args, 'default', context, d),
    ).toThrow('workflow flow for DEV-822 is abandoned; compose it again to start a new run')
  })

  test('an active cursor needing ship-to refuses a snapshot with no level', () => {
    const d = database()
    installShipToFlow(d)
    const opened = composeShipToFlow(d)
    replaceCursorAutonomy(d, (stored) => {
      delete stored.shipTo
    })

    expect(() =>
      getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', context, d),
    ).toThrow(
      `workflow cursor ${opened.cursor!.id}'s stored autonomy has no ship-to level; clear it with: ${PLATFORM_SLUG} workflow abandon --cursor ${opened.cursor!.id} --reason "<why>"; then start a new run with: ${PLATFORM_SLUG} workflow compose flow --project fixture --mode default --arg key=DEV-822 --arg branch=DEV-822-work --arg worktree=/tmp/work`,
    )
  })

  test('an active cursor not needing ship-to serves a snapshot with no level', () => {
    const d = database()
    composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d)
    replaceCursorAutonomy(d, (stored) => {
      delete stored.shipTo
    })

    expect(
      getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', context, d).slug,
    ).toBe('rebase')
  })
})
