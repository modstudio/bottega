import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { renderWorkflowComposition } from './workflow-render.ts'
import { resolveWorkflowCursorContext } from './workflow-cursor-selection.ts'
import {
  abandonCursor,
  args,
  context,
  database,
  selectAndNextWorkflowStep as nextWorkflowStep,
} from './workflow-cursor-test.fixture.ts'
import { attachWorkflowTextByHandle } from './workflow-text.ts'

describe('workflow cursor task reference', () => {
  test('an unknown user task key is stored as a label with no UUID link', async () => {
    const d = database()
    const unresolved = await resolveWorkflowCursorContext(
      'fixture',
      args,
      context,
      async () => null,
    )
    const composed = await composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      args,
      unresolved,
      d,
      {},
      {},
    )
    expect(d.query('SELECT workflow_key,task_record_id FROM workflow_cursor').get()).toEqual({
      workflow_key: 'DEV-822',
      task_record_id: null,
    })
    expect(renderWorkflowComposition(composed)).toContain(
      "workflow task DEV-822 in project fixture is unresolved; file or fix the task in the project's tracker, then rerun",
    )
    await expect(
      composeWorkflowWithCursor('flow', 'fixture', 'default', args, unresolved, d, {}, {}),
    ).rejects.toThrow(
      'task key DEV-822 names no task in hub and earlier cursor 1 holds that label; use a real task key',
    )
  })

  test('an unresolved task is reported again on advance', async () => {
    const d = database()
    const unresolved = await resolveWorkflowCursorContext(
      'fixture',
      args,
      context,
      async () => null,
    )
    const composed = await composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      args,
      unresolved,
      d,
      {},
      {},
    )
    d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

    const output = await nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      'advance unresolved task',
      unresolved,
      d,
      {},
      undefined,
      composed.cursor!.id,
    )

    expect(output).toContain(
      "workflow task DEV-822 in project fixture is unresolved; file or fix the task in the project's tracker, then rerun",
    )
  })

  test('abandon reports attached texts kept for an unresolved task', async () => {
    const d = database()
    const unresolved = await resolveWorkflowCursorContext(
      'fixture',
      args,
      context,
      async () => null,
    )
    const composed = await composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      args,
      unresolved,
      d,
      {},
      {},
    )
    const token = await attachWorkflowTextByHandle(
      composed.cursor!.id,
      'Keep this text.',
      unresolved,
      d,
    )

    const output = await abandonCursor(
      'flow',
      'fixture',
      'default',
      args,
      'unresolved task',
      unresolved,
      d,
      composed.cursor!.id,
    )

    expect(output).toContain(token)
    expect(output).toContain('workflow key DEV-822 in project fixture has an unresolved task link')
    expect(output).toContain(
      `bottega workflow text copy --cursor ${composed.cursor!.id} --project fixture`,
    )
    expect(d.query('SELECT COUNT(*) AS count FROM workflow_step_text').get()).toEqual({ count: 1 })
  })

  test('a pre-rollout cursor named by number links to its resolved task on next', async () => {
    let taskLookups = 0
    const d = database()
    await composeWorkflowWithCursor(
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
      .query<{ number: number; record_id: string }, []>(
        'SELECT number,record_id FROM workflow_cursor',
      )
      .get()!
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'2026-10-26','rollout?','workflow')`,
    ).run(newRecordId(), cursor.record_id, args.key)
    d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

    const resolved = await resolveWorkflowCursorContext('fixture', args, context, async () => {
      taskLookups++
      return { key: args.key, record_id: 'task-DEV-822', project: 'fixture' }
    })
    expect(taskLookups).toBe(1)
    await nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      'linked on selection',
      resolved,
      d,
      {},
      undefined,
      cursor.number,
    )

    expect(
      d.query('SELECT workflow_key,ordinal,task_record_id FROM workflow_cursor').get(),
    ).toEqual({
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
      await composeWorkflowWithCursor(
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
