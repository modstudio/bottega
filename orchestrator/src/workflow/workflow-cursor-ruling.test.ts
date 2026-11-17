import { describe, expect, test } from 'bun:test'
import { askQuestion } from '../question-store/question-store-mutation.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'

describe('workflow cursor ruling question selection', () => {
  test('await reuses the open question on the current step when the cursor is running', async () => {
    const d = database()
    await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
    const cursor = d
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor')
      .get()!
    const open = await askQuestion(d, {
      workflowCursorRecordId: cursor.record_id,
      workflowKey: args.key,
      askedAt: '2026-11-16T12:00:00.000Z',
      question: 'Original?',
      askedVia: 'workflow',
      awaitingOperatorAt: '2026-11-16T12:00:00.000Z',
    })
    d.exec(`CREATE TRIGGER keep_cursor_running AFTER UPDATE OF state ON workflow_cursor
      BEGIN UPDATE workflow_cursor SET state='running' WHERE record_id=NEW.record_id; END`)

    const result = await awaitWorkflowRuling(
      'flow',
      'fixture',
      'default',
      args,
      'Updated?',
      context,
      d,
      () => {},
    )

    expect(result.questionId).toBe(open.number)
    expect(d.query('SELECT count(*) count FROM question').get()).toEqual({ count: 1 })
    expect(d.query('SELECT question FROM question').get()).toEqual({ question: 'Updated?' })
  })

  test('rule selects the newest open question bound to the current step', async () => {
    const d = database()
    await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
    const cursor = d
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor')
      .get()!
    const askedAt = '2026-11-16T12:00:00.000Z'
    const otherStep = await askQuestion(d, {
      workflowCursorRecordId: cursor.record_id,
      askedAt,
      question: 'Other step?',
      askedVia: 'workflow',
    })
    d.query('UPDATE question SET workflow_step_ordinal=99,workflow_step_slug=? WHERE number=?').run(
      'other',
      otherStep.number,
    )
    const olderCurrent = await askQuestion(d, {
      workflowCursorRecordId: cursor.record_id,
      askedAt,
      question: 'Older current?',
      askedVia: 'workflow',
    })
    const newerCurrent = await askQuestion(d, {
      workflowCursorRecordId: cursor.record_id,
      askedAt,
      question: 'Newer current?',
      askedVia: 'workflow',
    })
    d.query("UPDATE workflow_cursor SET state='awaiting-ruling',question='Newer current?'").run()

    const ruled = await ruleWorkflow(
      'flow',
      'fixture',
      'default',
      args,
      'Proceed.',
      true,
      'mcp',
      context,
      d,
    )

    expect(ruled.questionId).toBe(newerCurrent.number)
    expect(d.query('SELECT number,answer FROM question ORDER BY number').all()).toEqual([
      { number: otherStep.number, answer: null },
      { number: olderCurrent.number, answer: null },
      { number: newerCurrent.number, answer: 'Proceed.' },
    ])
  })
})
