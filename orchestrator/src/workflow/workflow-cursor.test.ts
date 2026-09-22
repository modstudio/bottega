import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  listWorkflowCursors,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { renderWorkflowComposition } from './workflow-render.ts'
import { seedWorkflows } from './workflow-seeds.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ gate: 'bun run check', trunk: 'develop', docs: { protocol: 'orch-docs' } }),
  )
  return d
}

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one' }

describe('workflow cursor adapter', () => {
  test('compose creates once and recompose reports an advanced cursor', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const recomposed = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(d.query('SELECT count(*) count FROM workflow_cursor').get()).toEqual({ count: 1 })
    expect(renderWorkflowComposition(recomposed)).toContain(
      'Cursor: at step 2 lens (running); continue with next.',
    )
  })

  test('fetch ahead refuses, next records a note and advances', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    expect(() =>
      getWorkflowStepWithCursor('ship', 'fixture', 'score', args, 'default', context, d),
    ).toThrow(/at step 1 rebase.*workflow next ship/)

    expect(nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)).toContain(
      'fetch step 3 score',
    )
    expect(d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get()).toMatchObject({
      ordinal: 1,
      step_slug: 'lens',
    })
    expect(
      JSON.parse(
        (d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }).closed,
      )[0],
    ).toMatchObject({ n: 1, slug: 'rebase', note: 'rebased' })
  })

  test('last next marks done and open listing omits it', () => {
    const d = database()
    const composition = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor(
      'ship',
      'fixture',
      composition.steps[0]!.slug,
      args,
      'default',
      context,
      d,
    )
    expect(listWorkflowCursors({ session: 'session-one' }, d)).toHaveLength(1)
    let output = ''
    for (const step of composition.steps) {
      output = nextWorkflowStep(
        'ship',
        'fixture',
        'default',
        args,
        `closed ${step.slug}`,
        context,
        d,
      )
    }
    expect(output).toBe(
      `Workflow ship for DEV-822 is finished: ${composition.steps.length} steps closed.`,
    )
    expect(listWorkflowCursors({ session: 'session-one' }, d)).toEqual([])
    expect(d.query('SELECT state FROM workflow_cursor').get()).toEqual({ state: 'done' })
  })
})
