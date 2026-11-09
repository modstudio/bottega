import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags as flags,
  insertRun as insert,
  newQuestionSql,
} from '../../test/fixtures/run-answer.ts'
import { installRunAnswerEnvironment } from '../../test/fixtures/run-answer-environment.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { answerCommand } from './run-message-commands.ts'

let restoreEnvironment: () => void
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => restoreEnvironment())

test('answering a continuation turn question returns its root task moment line', async () => {
  const root = insert('ok')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
  const turn = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    parent: root,
    turn: 2,
    session: 'orch-test-session',
  })
  const question = db()
    .query<{ number: number }, [string, string, string]>(`${newQuestionSql()} RETURNING number`)
    .get(turn, new Date().toISOString(), 'Which shape?')!

  const writes = await answerCommand(turn, ['Keep the approved shape.'], true, false, flags, {
    printRunId: () => {},
  })

  expect(writes).toHaveLength(1)
  expect(writes[0]?.line).toBe(
    `context: write ruling on DEV-2225 (${PLATFORM_SLUG} agent context set --task 'DEV-2225' --kind ruling --source 'q${question.number}' --id ruling-q${question.number} '<text>')`,
  )
})

test('partial record-only answer returns one moment line for the selected question', async () => {
  const root = insert('asking')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
  const addQuestion = (question: string) =>
    db()
      .query<{ record_id: string; number: number }, [string, string, string]>(
        `${newQuestionSql()} RETURNING record_id,number`,
      )
      .get(root, new Date().toISOString(), question)!
  const first = addQuestion('First question?')
  const selected = addQuestion('Selected question?')

  const writes = await answerCommand(
    root,
    [`--q${selected.record_id}`, 'Use the selected answer.'],
    true,
    false,
    flags,
    { printRunId: () => {} },
  )

  expect(writes).toHaveLength(1)
  expect(writes[0]?.line).toBe(
    `context: write ruling on DEV-2225 (${PLATFORM_SLUG} agent context set --task 'DEV-2225' --kind ruling --source 'q${selected.number}' --id ruling-q${selected.number} '<text>')`,
  )
  expect(
    db()
      .query<{ record_id: string; answered_at: string | null }, [string]>(
        'SELECT record_id,answered_at FROM question WHERE run_record_id=? ORDER BY number',
      )
      .all(root),
  ).toEqual([
    { record_id: first.record_id, answered_at: null },
    { record_id: selected.record_id, answered_at: expect.any(String) },
  ])
})
