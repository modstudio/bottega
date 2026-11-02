import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFromArgv as answerRun,
  answerRunFlags as flags,
  answerRunHelpers as helpers,
  insertRun as insert,
} from '../../test/fixtures/run-answer.ts'
import { installRunAnswerEnvironment } from '../../test/fixtures/run-answer-environment.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'

let restoreEnvironment: () => void
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => restoreEnvironment())

test('a misspelled answer is refused and leaves the question open', async () => {
  const id = insert('asking')
  const misspelling = ['me', 'ida'].join('')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,awaiting_operator_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?)`,
    )
    .run(id, new Date().toISOString(), 'Which shape?', new Date().toISOString())
  await expect(
    answerRun(id, { argv: [`We saw the ${misspelling} here.`], recordOnly: true, flags }, helpers),
  ).rejects.toThrow(`answer text:\n"${misspelling}"`)
  expect(
    db().query('SELECT answer,answered_at FROM question WHERE run_record_id=?').get(id),
  ).toEqual({
    answer: null,
    answered_at: null,
  })
})
