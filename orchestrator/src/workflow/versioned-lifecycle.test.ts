import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  listWorkflows,
  retireWorkflow,
  setWorkflow,
  showWorkflow,
  type WorkflowDefinition,
  workflowVersions,
} from './workflows.ts'

const definition = (title: string): WorkflowDefinition => ({
  title,
  description: 'Exercises version retirement.',
  arguments: [],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['lens'] }],
})

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  return d
}

describe('versioned lifecycle retirement', () => {
  test('retires a draft, preserves its null promotion time, and records the event', () => {
    const d = database()
    const draft = setWorkflow('withdraw-draft', definition('Withdraw draft'), 'create', 'writer', d)

    const retired = retireWorkflow('withdraw-draft', draft.n, 'superseded', 'architect', d)

    expect(retired).toMatchObject({
      status: 'retired',
      promoted_at: null,
      retired_at: expect.any(String),
    })
    expect(workflowVersions('withdraw-draft', d)[0]!.events).toContainEqual(
      expect.objectContaining({ event: 'retire', reason: 'superseded', author: 'architect' }),
    )
  })

  test('retires a production version without clearing its promotion time', () => {
    const d = database()
    const production = showWorkflow('fixture-workflow', undefined, d)

    const retired = retireWorkflow('fixture-workflow', production.n, 'withdraw production', 'architect', d)

    expect(retired).toMatchObject({
      status: 'retired',
      promoted_at: production.promoted_at,
      retired_at: expect.any(String),
    })
  })

  test('refuses an already-retired version and names its state', () => {
    const d = database()
    const draft = setWorkflow('retired-state', definition('Retired state'), 'create', 'writer', d)
    retireWorkflow('retired-state', draft.n, 'withdraw', 'architect', d)

    expect(() =>
      retireWorkflow('retired-state', draft.n, 'withdraw again', 'architect', d),
    ).toThrow('workflow "retired-state" version 1 is retired')
  })

  test('does not list a withdrawn draft as the current draft', () => {
    const d = database()
    const draft = setWorkflow('draft-listing', definition('Draft listing'), 'create', 'writer', d)
    retireWorkflow('draft-listing', draft.n, 'withdraw', 'architect', d)

    expect(listWorkflows(d).find(({ slug }) => slug === 'draft-listing')).toMatchObject({
      production_n: null,
      draft_n: null,
    })
  })
})
