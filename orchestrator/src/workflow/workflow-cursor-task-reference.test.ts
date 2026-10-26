import { describe, expect, test } from 'bun:test'
import { composeWorkflowWithCursor, getWorkflowStepWithCursor } from './workflow-cursor.ts'
import { resolveWorkflowCursorContext } from './workflow-cursor-selection.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'

describe('workflow cursor task reference', () => {
  test('a user task key resolves to its UUID for cursor creation and selection', async () => {
    const d = database()
    const resolved = await resolveWorkflowCursorContext('fixture', args.key, context, async () => [
      { key: args.key, record_id: 'task-DEV-822', project: 'fixture' },
    ])
    composeWorkflowWithCursor('flow', 'fixture', 'default', args, resolved, d, {}, {})

    expect(d.query('SELECT workflow_key,task_record_id FROM workflow_cursor').get()).toEqual({
      workflow_key: 'DEV-822',
      task_record_id: 'task-DEV-822',
    })
    expect(
      getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', resolved, d, {})
        .cursor,
    ).toBe(1)
  })

  test('an unknown user task key is stored as a label with no UUID link', async () => {
    const d = database()
    const unresolved = await resolveWorkflowCursorContext(
      'fixture',
      args.key,
      context,
      async () => [],
    )
    composeWorkflowWithCursor('flow', 'fixture', 'default', args, unresolved, d, {}, {})
    expect(d.query('SELECT workflow_key,task_record_id FROM workflow_cursor').get()).toEqual({
      workflow_key: 'DEV-822',
      task_record_id: null,
    })
    expect(() =>
      composeWorkflowWithCursor('flow', 'fixture', 'default', args, unresolved, d, {}, {}),
    ).toThrow(
      'task key DEV-822 names no task in hub and earlier cursor 1 holds that label; use a real task key',
    )
  })
})
