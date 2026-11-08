import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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

function typedRun(
  kind: string,
  column: 'typed_options' | 'criteria' | 'levels',
  values: unknown,
): string {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'valid-session', id)
  db()
    .query(
      `INSERT INTO question
        (number,record_id,run_record_id,asked_at,question,kind,${column})
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
    )
    .run(id, new Date().toISOString(), 'typed question?', kind, JSON.stringify(values))
  return id
}

describe('typed values through the answer service', () => {
  test('CLI typed value records agreement', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    db().query('UPDATE question SET jev_pick=? WHERE run_record_id=?').run('"existing"', id)
    await answerRun(id, { argv: ['--value', 'existing'], recordOnly: true, flags }, helpers)
    expect(
      db()
        .query(
          'SELECT answer_value,answered_by_kind,jev_agreed FROM question WHERE run_record_id=?',
        )
        .get(id),
    ).toEqual({ answer_value: '"existing"', answered_by_kind: 'architect', jev_agreed: 1 })
  })

  test('out-of-range score names the allowed values', async () => {
    const id = typedRun('score', 'levels', ['low', 'high'])
    await expect(
      answerRun(id, { argv: ['--value', '2'], recordOnly: true, flags }, helpers),
    ).rejects.toThrow('allowed values: 0, 1')
  })

  test('matching choice ruling text counts as its typed value', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'Existing' }, { name: 'New' }])
    await answerRun(id, { argv: [' existing '], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"Existing"',
    })
  })

  test('choice ruling text matches with format characters and collapsed whitespace', async () => {
    const id = typedRun('choice', 'typed_options', [
      { name: 'Refresh the base' },
      { name: 'Keep the base' },
    ])
    await answerRun(id, { argv: ['Refresh\u200B  the base'], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"Refresh the base"',
    })
  })

  test('stored choice refused by the current schema records free text without a typed value', async () => {
    const id = typedRun('choice', 'typed_options', [
      { name: 'Refresh the base' },
      { name: 'refresh the base' },
    ])
    await answerRun(id, { argv: ['Refresh the base'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer,answer_value FROM question WHERE run_record_id=?').get(id),
    ).toEqual({ answer: 'Refresh the base', answer_value: null })
  })

  test('legacy choice options remain answerable without typed options', async () => {
    const id = insert('asking')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
      .run('orch-test-session', 'valid-session', id)
    db()
      .query(
        `INSERT INTO question
         (number,record_id,run_record_id,asked_at,question,kind,options)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        id,
        new Date().toISOString(),
        'legacy question?',
        'choice',
        JSON.stringify(['Existing', 'New']),
      )
    await answerRun(id, { argv: [' existing '], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"Existing"',
    })
  })

  test('matching yesno ruling text counts as its typed value', async () => {
    const id = typedRun('yesno', 'criteria', { yes: 'proceed', no: 'stop' })
    db().query('UPDATE question SET jev_pick=? WHERE run_record_id=?').run('true', id)
    await answerRun(id, { argv: [' yes '], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value,jev_agreed FROM question WHERE run_record_id=?').get(id),
    ).toEqual({ answer_value: 'true', jev_agreed: 1 })
  })

  test('CLI records disagreement and leaves agreement null without Jev advice', async () => {
    const disagreed = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    db().query('UPDATE question SET jev_pick=? WHERE run_record_id=?').run('"existing"', disagreed)
    await answerRun(disagreed, { argv: ['--value', 'new'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT jev_agreed FROM question WHERE run_record_id=?').get(disagreed),
    ).toEqual({ jev_agreed: 0 })

    const unadvised = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    await answerRun(unadvised, { argv: ['--value', 'new'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT jev_agreed FROM question WHERE run_record_id=?').get(unadvised),
    ).toEqual({ jev_agreed: null })
  })
})
