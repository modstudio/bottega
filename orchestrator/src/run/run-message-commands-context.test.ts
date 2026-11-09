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
