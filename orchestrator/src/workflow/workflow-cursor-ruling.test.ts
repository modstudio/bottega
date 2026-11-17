import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { askQuestion } from '../question-store/question-store-mutation.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'

describe('workflow cursor ruling question selection', () => {
  test('rule names an open cursor question whose step is missing', async () => {
    const d = database()
    await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
    const awaited = await awaitWorkflowRuling(
      'flow',
      'fixture',
      'default',
      args,
      'Proceed?',
      context,
      d,
      () => {},
    )
    const question = d.query<{ record_id: string }, []>('SELECT record_id FROM question').get()!
    d.run('UPDATE question SET workflow_step_ordinal=NULL,workflow_step_slug=NULL')
    d.run("UPDATE workflow_cursor SET state='running'")
    const prefix = `question ${awaited.questionId} (record ${question.record_id}) is open on this cursor but carries no step, so no workflow verb can rule on it`
    const runningRemedy = `${prefix}; close it with \`${PLATFORM_SLUG} question close ${question.record_id} --reason <why>\`, then record the question again with \`${PLATFORM_SLUG} workflow await\``

    await expect(
      ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', true, 'cli', context, d),
    ).rejects.toThrow(`is not awaiting a ruling; ${runningRemedy}`)

    d.run("UPDATE workflow_cursor SET state='awaiting-ruling'")
    const awaitingRemedy = `${prefix}; record the question again with \`${PLATFORM_SLUG} workflow await\`, which records a new question bound to this step. Question ${awaited.questionId} can be closed with \`${PLATFORM_SLUG} question close ${question.record_id} --reason <why>\` once the cursor is no longer awaiting a ruling`
    await expect(
      ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', true, 'cli', context, d),
    ).rejects.toThrow(`has no open question to rule on; ${awaitingRemedy}`)
  })

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
