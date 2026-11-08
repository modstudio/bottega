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

  test('stored choice refused by the current schema accepts prose without a typed value', async () => {
    const id = typedRun('choice', 'typed_options', [
      { name: 'Refresh the base' },
      { name: 'refresh the base' },
    ])
    await answerRun(id, { argv: ['Refresh the base'], recordOnly: true, flags }, helpers)
    expect(
      db()
        .query('SELECT answer,answer_value,answered_at FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: 'Refresh the base', answer_value: null, answered_at: expect.any(String) })
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

  test('leading choice segment selects the whole matching option name', async () => {
    const longer = typedRun('choice', 'typed_options', [{ name: 'A' }, { name: 'A + F' }])
    await answerRun(longer, { argv: ['A + F. reasons'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(longer),
    ).toEqual({ answer_value: '"A + F"' })

    const shorter = typedRun('choice', 'typed_options', [{ name: 'A' }, { name: 'A + F' }])
    await answerRun(shorter, { argv: ['A. reasons'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(shorter),
    ).toEqual({ answer_value: '"A"' })

    const punctuation = typedRun('choice', 'typed_options', [
      { name: 'A - B' },
      { name: 'Something else' },
    ])
    await answerRun(punctuation, { argv: ['A - B'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(punctuation),
    ).toEqual({ answer_value: '"A - B"' })
  })

  test('leading segments infer yesno and score values', async () => {
    const yesno = typedRun('yesno', 'criteria', { yes: 'proceed', no: 'stop' })
    await answerRun(yesno, { argv: ['Yes, proceed'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(yesno),
    ).toEqual({ answer_value: 'true' })

    const score = typedRun('score', 'levels', ['low', 'high'])
    await answerRun(score, { argv: ['1: high confidence'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(score),
    ).toEqual({ answer_value: '1' })
  })

  test('a comma ends the leading choice segment', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'Existing' }, { name: 'New' }])
    await answerRun(
      id,
      { argv: ['Existing, because it already works'], recordOnly: true, flags },
      helpers,
    )
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"Existing"',
    })
  })

  test('choice ruling without a leading match refuses and stores nothing', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'Existing' }, { name: 'New' }])
    await expect(
      answerRun(id, { argv: ['Use the existing shape'], recordOnly: true, flags }, helpers),
    ).rejects.toThrow(
      /question \d+ requires a typed value; allowed values: Existing, New; pass --value <name> \(or --value none\), or start the ruling with the option name/,
    )
    expect(
      db()
        .query('SELECT answer,answer_value,answered_at FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: null, answer_value: null, answered_at: null })
  })

  test('none records that no choice fits and disagrees with Jev advice', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    db().query('UPDATE question SET jev_pick=? WHERE run_record_id=?').run('"existing"', id)
    await answerRun(
      id,
      { argv: ['--value', 'none', 'Neither option applies'], recordOnly: true, flags },
      helpers,
    )
    expect(
      db()
        .query('SELECT answer,answer_value,jev_agreed FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: 'Neither option applies', answer_value: null, jev_agreed: 0 })
  })

  test('none leaves agreement null without Jev advice', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    await answerRun(
      id,
      { argv: ['--value', 'none', 'Build a third shape instead'], recordOnly: true, flags },
      helpers,
    )
    expect(
      db().query('SELECT answer_value,jev_agreed FROM question WHERE run_record_id=?').get(id),
    ).toEqual({ answer_value: null, jev_agreed: null })
  })

  test('a leading None segment records that no choice fits', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    await answerRun(id, { argv: ['None: neither fits'], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: null,
    })
  })

  test('bare none is refused and leaves the question open', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'existing' }, { name: 'new' }])
    await expect(
      answerRun(id, { argv: ['--value', 'none'], recordOnly: true, flags }, helpers),
    ).rejects.toThrow('--value none "<what to do>" or None: <what to do>')
    expect(
      db()
        .query('SELECT answer,answer_value,answered_at FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: null, answer_value: null, answered_at: null })
  })

  test('a choice option literally named none takes precedence', async () => {
    const id = typedRun('choice', 'typed_options', [{ name: 'none' }, { name: 'existing' }])
    await answerRun(id, { argv: ['--value', 'none'], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"none"',
    })
  })

  test('none refuses a yesno ruling and leaves the question open', async () => {
    const id = typedRun('yesno', 'criteria', { yes: 'proceed', no: 'stop' })
    await expect(
      answerRun(id, { argv: ['--value', 'none'], recordOnly: true, flags }, helpers),
    ).rejects.toThrow(/question \d+ refuses that typed value; allowed values: yes, no/)
    expect(
      db()
        .query('SELECT answer,answer_value,answered_at FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: null, answer_value: null, answered_at: null })
  })

  test('a text question records an explicit value', async () => {
    const id = insert('asking')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
      .run('orch-test-session', 'valid-session', id)
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question,kind)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?)`,
      )
      .run(id, new Date().toISOString(), 'text question?', 'text')
    await answerRun(
      id,
      { argv: ['--value', 'stored value', 'Use it'], recordOnly: true, flags },
      helpers,
    )
    expect(db().query('SELECT answer_value FROM question WHERE run_record_id=?').get(id)).toEqual({
      answer_value: '"stored value"',
    })
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
