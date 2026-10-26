import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations } from '../database/migrations.ts'
import type { AutonomyResolution, CursorAutonomyResolution } from './autonomy.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursor,
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
} from './workflow-cursor.ts'
import { combineCursorAutonomy, mapStoredAutonomyResolution } from './workflow-cursor-autonomy.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { composeWorkflow } from './workflows.ts'

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one', taskRecordId: 'task-DEV-822' }

const pinnedAutonomy = (): CursorAutonomyResolution => ({
  steps: { lens: { value: 'auto', scope: 'pinned step' } },
  stages: { review: { value: 'auto', scope: 'pinned stage' } },
  rulings: { value: 'agent', scope: 'pinned rulings' },
  shipTo: { value: 'trunk', scope: 'pinned ship-to' },
  cursor: { id: 7, composeCommand: `${PLATFORM_SLUG} workflow compose flow` },
})

const liveAutonomy = (): AutonomyResolution => ({
  steps: { lens: { value: 'ask', scope: 'live step' } },
  stages: { review: { value: 'ask', scope: 'live stage' } },
  rulings: { value: 'user', scope: 'live rulings' },
  shipTo: { value: 'branch', scope: 'live ship-to' },
})

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
  const catalogue = setStepCatalogueLocal(
    {
      steps: current.steps.map((step) =>
        step.slug === 'rebase'
          ? {
              ...step,
              body: 'Ship to {{shipTo.level}}.',
              needs: [...step.needs, 'ship-to'],
            }
          : step,
      ),
    },
    'ship-to cursor fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish ship-to cursor fixture', 'test', d)
}

function replaceCursorAutonomy(
  d: Database,
  change: (stored: Record<string, unknown>) => void,
): void {
  const row = d.query('SELECT autonomy FROM workflow_cursor').get() as {
    autonomy: string
  }
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
      resolution: {
        steps: Object.fromEntries(composed.steps.map((step) => [step.slug, step.resolvedAutonomy])),
        rulings: composed.rulings,
        shipTo: { value: 'trunk', scope: 'test' },
      },
    },
  )
}

describe('workflow cursor stored autonomy', () => {
  test('combines a stricter live resolution across autonomy subjects', () => {
    const combined = combineCursorAutonomy(pinnedAutonomy(), liveAutonomy())

    expect(combined.resolution.steps.lens).toEqual({
      value: 'ask',
      scope: 'live step',
    })
    expect(combined.resolution.stages?.review).toEqual({
      value: 'ask',
      scope: 'live stage',
    })
    expect(combined.resolution.rulings).toEqual({
      value: 'user',
      scope: 'live rulings',
    })
    expect(combined.resolution.shipTo).toEqual({
      value: 'branch',
      scope: 'live ship-to',
    })
    expect(combined.looserLiveDifferences).toEqual([])
  })

  test('keeps stricter pins and reports looser live settings', () => {
    const pinned = pinnedAutonomy()
    pinned.steps.lens = { value: 'ask', scope: 'pinned step' }
    pinned.stages!.review = { value: 'ask', scope: 'pinned stage' }
    pinned.rulings = { value: 'user', scope: 'pinned rulings' }
    const live = liveAutonomy()
    live.steps.lens = { value: 'auto', scope: 'live step' }
    live.stages!.review = { value: 'auto', scope: 'live stage' }
    live.rulings = { value: 'agent', scope: 'live rulings' }
    live.shipTo = { value: 'production', scope: 'live ship-to' }

    expect(combineCursorAutonomy(pinned, live)).toEqual({
      resolution: pinned,
      looserLiveDifferences: [
        { subject: 'steps.lens', pinned: 'ask', live: 'auto' },
        { subject: 'stages.review', pinned: 'ask', live: 'auto' },
        { subject: 'rulings', pinned: 'user', live: 'agent' },
        { subject: 'ship-to', pinned: 'trunk', live: 'production' },
      ],
    })
  })

  test('keeps the pinned scope when strictness ties', () => {
    const pinned = pinnedAutonomy()
    const live = liveAutonomy()
    live.steps.lens = { value: 'auto', scope: 'live step' }

    expect(combineCursorAutonomy(pinned, live).resolution.steps.lens).toEqual({
      value: 'auto',
      scope: 'pinned step',
    })
  })

  test('returns the pin unchanged when no live resolution is available', () => {
    const pinned = pinnedAutonomy()

    expect(combineCursorAutonomy(pinned)).toEqual({
      resolution: pinned,
      looserLiveDifferences: [],
    })
  })

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
      getWorkflowStepWithCursor('flow', 'fixture', 'lens', args, 'default', context, d, {}),
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
      getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', context, d, {}),
    ).toThrow(
      `workflow cursor ${opened.cursor!.id}'s stored autonomy has no ship-to level; clear it with: ${PLATFORM_SLUG} workflow abandon --cursor ${opened.cursor!.id} --reason "<why>"; then start a new run with: ${PLATFORM_SLUG} workflow compose flow --project fixture --mode default --arg key=DEV-822 --arg branch=DEV-822-work --arg worktree=/tmp/work`,
    )
  })

  test('an active cursor not needing ship-to serves a snapshot with no level', () => {
    const d = database()
    composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
    replaceCursorAutonomy(d, (stored) => {
      delete stored.shipTo
    })

    expect(
      getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', context, d, {}).slug,
    ).toBe('rebase')
  })
})
