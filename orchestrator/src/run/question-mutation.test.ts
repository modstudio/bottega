import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { answerWorkflowQuestion, authorizeWorkflowQuestionMutation } from './question-mutation.ts'

const now = Date.parse('2026-10-25T06:00:00.000Z')

test('answering a missing workflow question names the inbox lookup remedy', async () => {
  const questionId = newRecordId()
  await expect(
    answerWorkflowQuestion(
      {
        questionId,
        cursorId: newRecordId(),
        ruling: 'Proceed.',
        at: '2026-10-25T06:00:00.000Z',
        actor: null,
        fromOperator: false,
        personName: null,
        channel: 'cli',
      },
      migratedTestDatabase(),
    ),
  ).rejects.toThrow(
    `question ${questionId} was not found; check the identifier with ${PLATFORM_SLUG} question inbox --all`,
  )
})

test('workflow question adoption audit names dead-process and ownership-window grounds', () => {
  const database = migratedTestDatabase()
  database
    .query('INSERT INTO session_seen(session_id,last_seen,ancestor_chain) VALUES (?,?,?)')
    .run(
      'dead-owner',
      '2026-10-25T04:00:00.000Z',
      JSON.stringify([{ pid: 987_654, startTime: 'owner-start' }]),
    )

  expect(
    authorizeWorkflowQuestionMutation({
      owner: 'dead-owner',
      actor: 'successor',
      fromOperator: false,
      subject: 'workflow question',
      action: 'rule',
      chainLastActivityAt: now,
      now,
      database,
      probe: () => ({ alive: false, startTime: null }),
    }),
  ).toBe('adopted from dead owner dead-owner (pids 987654 gone or reused) by successor')

  expect(
    authorizeWorkflowQuestionMutation({
      owner: 'window-owner',
      actor: 'successor',
      fromOperator: false,
      subject: 'workflow question',
      action: 'rule',
      chainLastActivityAt: 0,
      now,
      database,
    }),
  ).toBe('adopted from gone owner window-owner by successor')
})
