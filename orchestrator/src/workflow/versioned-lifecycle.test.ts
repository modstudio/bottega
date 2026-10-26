import { describe, expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  listResolvedWorkflows,
  resolvedWorkflowVersions,
  retireWorkflowLocal,
  setWorkflowLocal,
  showResolvedWorkflow,
  type WorkflowDefinition,
} from './workflows.ts'

const definition = (title: string): WorkflowDefinition => ({
  title,
  description: 'Exercises version retirement.',
  arguments: [],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['lens'] }],
})

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
})

describe('versioned lifecycle retirement', () => {
  test('retires a draft, preserves its null promotion time, and records the event', () => {
    const d = database()
    const draft = setWorkflowLocal(
      'withdraw-draft',
      definition('Withdraw draft'),
      'create',
      'writer',
      d,
    )

    const retired = retireWorkflowLocal('withdraw-draft', draft.n, 'superseded', 'architect', d)

    expect(retired).toMatchObject({
      status: 'retired',
      promoted_at: null,
      retired_at: expect.any(String),
    })
    for (const row of d
      .query<{ record_id: string }, []>(
        "SELECT record_id FROM workflow WHERE slug='withdraw-draft' UNION ALL SELECT record_id FROM workflow_version WHERE workflow_record_id=(SELECT record_id FROM workflow WHERE slug='withdraw-draft') UNION ALL SELECT event.record_id FROM workflow_event event JOIN workflow_version version ON version.record_id=event.workflow_version_record_id WHERE version.workflow_record_id=(SELECT record_id FROM workflow WHERE slug='withdraw-draft')",
      )
      .all()) {
      expect(row.record_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
    expect(resolvedWorkflowVersions('withdraw-draft', null, d)[0]!.events).toContainEqual(
      expect.objectContaining({ event: 'retire', reason: 'superseded', author: 'architect' }),
    )
  })

  test('retires a production version without clearing its promotion time', () => {
    const d = database()
    const production = showResolvedWorkflow('flow', undefined, null, d)

    const retired = retireWorkflowLocal('flow', production.n, 'withdraw production', 'architect', d)

    expect(retired).toMatchObject({
      status: 'retired',
      promoted_at: production.promoted_at,
      retired_at: expect.any(String),
    })
  })

  test('refuses an already-retired version and names its state', () => {
    const d = database()
    const draft = setWorkflowLocal(
      'retired-state',
      definition('Retired state'),
      'create',
      'writer',
      d,
    )
    retireWorkflowLocal('retired-state', draft.n, 'withdraw', 'architect', d)

    expect(() =>
      retireWorkflowLocal('retired-state', draft.n, 'withdraw again', 'architect', d),
    ).toThrow('workflow "retired-state" version 1 is retired')
  })

  test('lists a withdrawn draft only when the listing asks for retired workflows', () => {
    const d = database()
    const draft = setWorkflowLocal(
      'draft-listing',
      definition('Draft listing'),
      'create',
      'writer',
      d,
    )
    retireWorkflowLocal('draft-listing', draft.n, 'withdraw', 'architect', d)

    expect(listResolvedWorkflows(null, d).map(({ slug }) => slug)).not.toContain('draft-listing')
    expect(listResolvedWorkflows(null, d, true).find(({ slug }) => slug === 'draft-listing')).toMatchObject(
      {
        production_n: null,
        draft_n: null,
      },
    )
  })
})
