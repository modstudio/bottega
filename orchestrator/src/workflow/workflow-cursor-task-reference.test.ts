import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  composeWorkflowWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { resolveWorkflowCursorContext } from './workflow-cursor-selection.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'

describe('workflow cursor task reference', () => {
  test('an unknown user task key is stored as a label with no UUID link', async () => {
    const d = database()
    const unresolved = await resolveWorkflowCursorContext(
      'fixture',
      args,
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

  test('resolving a selector key links and selects a cursor created before rollout', async () => {
    const d = database()
    composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      args,
      { ...context, taskRecordId: null },
      d,
      {},
      {},
    )
    const cursor = d
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor')
      .get()!
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'2026-10-26','rollout?','workflow')`,
    ).run(newRecordId(), cursor.record_id, args.key)
    d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

    const resolved = await resolveWorkflowCursorContext(
      'fixture',
      args,
      context,
      async () => [{ key: args.key, record_id: 'task-DEV-822', project: 'fixture' }],
    )
    nextWorkflowStep('flow', 'fixture', 'default', args, 'linked on selection', resolved, d)

    expect(d.query('SELECT workflow_key,ordinal,task_record_id FROM workflow_cursor').get()).toEqual({
      workflow_key: 'DEV-822',
      ordinal: 1,
      task_record_id: 'task-DEV-822',
    })
    expect(d.query('SELECT workflow_task_record_id FROM question').get()).toEqual({
      workflow_task_record_id: 'task-DEV-822',
    })
  })

  test('a supplied task cannot select or move that task cursor instead of the selector cursor', async () => {
    const d = database()
    for (const key of ['DEV-A', 'DEV-B']) {
      composeWorkflowWithCursor(
        'flow',
        'fixture',
        'default',
        { ...args, key },
        { ...context, taskRecordId: `task-${key}` },
        d,
        {},
        {},
      )
    }
    d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

    expect(() =>
      nextWorkflowStep(
        'flow',
        'fixture',
        'default',
        { ...args, key: 'DEV-A' },
        'must refuse mismatch',
        {
          ...context,
          taskRecordId: 'task-DEV-A',
          adoptionTaskRecordId: 'task-DEV-B',
        },
        d,
        { task: 'DEV-B' },
      ),
    ).toThrow('cursor 1 is already assigned to DEV-A; it cannot adopt DEV-B')
    expect(
      d.query('SELECT workflow_key,ordinal FROM workflow_cursor ORDER BY workflow_key').all(),
    ).toEqual([
      { workflow_key: 'DEV-A', ordinal: 0 },
      { workflow_key: 'DEV-B', ordinal: 0 },
    ])
  })
})
