import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { installRecordToken } from '../../test/fixtures/record-session.ts'
import {
  addOpenQuestions,
  answerRunFromArgv as answerRun,
  answerRunFlags as flags,
  answerRunHelpers as helpers,
  insertRun as insert,
  newQuestionSql,
  packedRulingResumeBytes,
} from '../../test/fixtures/run-answer.ts'
import { installRunAnswerEnvironment } from '../../test/fixtures/run-answer-environment.ts'
import { dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'

const trackResidue = trackedTestResidue()

let restoreEnvironment: () => void
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => {
  installRecordToken(null)
  restoreEnvironment()
})

test('answer shape is checked before storage using its operator attribution', async () => {
  const answer = 'x'.repeat(801)
  const selfRuled = insert('asking')
  db().query(newQuestionSql()).run(selfRuled, new Date().toISOString(), 'which shape?')

  await expect(
    answerRun(selfRuled, { argv: [answer], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('self-ruling is 801 characters; the limit is 800')
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(selfRuled)).toEqual({
    answer: null,
  })

  const operatorRuled = insert('asking')
  db().query(newQuestionSql()).run(operatorRuled, new Date().toISOString(), 'which shape?')
  await answerRun(
    operatorRuled,
    { argv: ['--from-operator', answer], recordOnly: true, flags },
    helpers,
  )
  expect(
    db().query('SELECT answer FROM question WHERE run_record_id=?').get(operatorRuled),
  ).toEqual({
    answer,
  })
})

test('multi-question self-ruling refusal leaves every answer unstored', async () => {
  const id = insert('asking')
  const questions = addOpenQuestions(id, 2)
  const answer = 'x'.repeat(801)

  await expect(
    answerRun(
      id,
      {
        argv: [`--q${questions[0]!.number}`, 'first answer', `--q${questions[1]!.number}`, answer],
        recordOnly: true,
        flags,
      },
      helpers,
    ),
  ).rejects.toThrow('self-ruling is 801 characters; the limit is 800')
  expect(
    db().query('SELECT answer FROM question WHERE run_record_id=? ORDER BY number').all(id),
  ).toEqual(questions.map(() => ({ answer: null })))
})

test('answer refuses an over-limit --file ruling before storing any answer', async () => {
  const id = insert('asking', 'implement')
  const spec = trackResidue(join(dir, `answer-six-large-${id}.prompt.txt`))
  writeFileSync(spec, 'original implementation spec')
  db()
    .query('UPDATE run SET vendor_session=?, prompt_path=?, session_id=? WHERE record_id=?')
    .run('parent-session', spec, 'orch-test-session', id)
  const body = 'x'.repeat(190_000)
  const questions = addOpenQuestions(id, 6)
  const argv: string[] = []
  for (const question of questions) {
    const path = trackResidue(join(dir, `answer-large-${question.number}.txt`))
    writeFileSync(path, body)
    argv.push(`--from-operator-q${question.number}`, `--q${question.number}`, '--file', path)
  }
  await expect(answerRun(id, { argv, recordOnly: false, flags }, helpers)).rejects.toThrow(
    'ruling is 190000 characters; the limit is 1500 (RULING_MAX_CHARS)',
  )
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').all(id)).toEqual(
    questions.map(() => ({ answer: null })),
  )
  expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(id)).toEqual({
    n: 0,
  })
})

test('answer refuses individually legal rulings when the packed resume exceeds argv', async () => {
  const id = insert('asking', 'implement')
  const spec = trackResidue(join(dir, `answer-packed-large-${id}.prompt.txt`))
  writeFileSync(spec, 's'.repeat(600))
  db()
    .query('UPDATE run SET vendor_session=?, prompt_path=?, session_id=? WHERE record_id=?')
    .run('parent-session', spec, 'orch-test-session', id)
  const body = 'x'.repeat(1500)
  const questions = addOpenQuestions(id, 134)
  const argv = questions.flatMap((question) => [
    `--from-operator-q${question.number}`,
    `--q${question.number}`,
    body,
  ])
  const assembled = packedRulingResumeBytes(id, 'implement', questions, body)
  await expect(answerRun(id, { argv, recordOnly: false, flags }, helpers)).rejects.toThrow(
    `assembled resume prompt is ${assembled} bytes`,
  )
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').all(id)).toEqual(
    questions.map(() => ({ answer: null })),
  )
})
