import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags as flags,
  insertRun,
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

test('answer repairs an orphaned asking turn before reading its superseded question', async () => {
  const root = insertRun('ok', 'implement')
  const asking = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    parent: root,
    turn: 2,
    session: 'orch-test-session',
  })
  addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: root,
    turn: 3,
    session: 'orch-test-session',
  })
  db().query('UPDATE run SET session_id=? WHERE record_id=?').run('orch-test-session', root)
  db().query(newQuestionSql()).run(asking, new Date().toISOString(), 'obsolete question?')

  await expect(
    answerCommand(root, ['obsolete answer'], false, false, flags, { printRunId: () => {} }),
  ).rejects.toThrow()
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(asking)).toEqual({
    status: 'ok',
  })
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(asking)).toEqual({
    answer: null,
  })
  expect(
    db().query('SELECT action FROM run_mutation_audit WHERE run_record_id=?').get(asking),
  ).toEqual({ action: 'reap' })
})
