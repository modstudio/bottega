import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARGV_PROMPT_BYTES, addRun, db, dir, packedResumePrompt, rulingPrompt } from '../test/fixture.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from './args.ts'
import { answerRun } from './run-answer.ts'

const presentation = {
  dur: (ms: number | null | undefined) => String(ms ?? 0),
  scoreHint: () => '', argvResumeLimit: () => ARGV_PROMPT_BYTES,
  printRunId: () => {},
}
const helpers = {
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  assertWorkerText, readWorkerFile, readMessageText, presentation,
}
const flags = { detach: true, follow: false, quiet: true }

function insert(status: string, job = 'file-question'): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id
}

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  process.env.ORCH_DEPTH = '0'
  process.env.ORCH_EXEC_PATH = '/usr/bin/true'
})

describe('run answers', () => {
  test('answer refuses six individually-legal --file rulings whose packed resume exceeds argv', async () => {
    const id = insert('asking', 'implement')
    const spec = join(dir, `answer-six-large-${id}.prompt.txt`)
    writeFileSync(spec, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=?, session_id=? WHERE id=?')
      .run('parent-session', spec, 'orch-test-session', id)
    const body = 'x'.repeat(190_000)
    for (let i = 1; i <= 6; i++) db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(id, new Date().toISOString(), `q${i}?`)
    const questions = db().query('SELECT id, question FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number; question: string }[]
    const argv: string[] = []
    for (const question of questions) {
      const path = join(dir, `answer-large-${question.id}.txt`)
      writeFileSync(path, body)
      argv.push(`--q${question.id}`, '--file', path)
    }
    const assembled = Buffer.byteLength(packedResumePrompt(
      'implement', rulingPrompt(questions.map((q) => ({ question: q.question, answer: body }))), id,
    ))
    await expect(answerRun(id, { argv, recordOnly: false, flags }, helpers)).rejects.toThrow(
      `assembled resume prompt is ${assembled} bytes`,
    )
    expect(db().query('SELECT answer FROM question WHERE run_id=?').all(id))
      .toEqual(questions.map(() => ({ answer: null })))
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id)).toEqual({ n: 0 })
  })

  test('answer accepts six small --file rulings and resumes', async () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET vendor_session=?, session_id=?, cwd=? WHERE id=?')
      .run('parent-session', 'orch-test-session', dir, id)
    for (let i = 1; i <= 6; i++) db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(id, new Date().toISOString(), `q${i}?`)
    const questions = db().query('SELECT id FROM question WHERE run_id=? ORDER BY id').all(id) as { id: number }[]
    const argv: string[] = []
    for (const question of questions) {
      const path = join(dir, `answer-small-${question.id}.txt`)
      writeFileSync(path, `yes ${question.id}`)
      argv.push(`--q${question.id}`, '--file', path)
    }
    await answerRun(id, { argv, recordOnly: false, flags }, helpers)
    expect(db().query('SELECT answer FROM question WHERE run_id=? ORDER BY id').all(id))
      .toEqual(questions.map((q) => ({ answer: `yes ${q.id}` })))
    const child = db().query('SELECT parent_run_id,prompt_path FROM run WHERE parent_run_id=?').get(id) as
      { parent_run_id: number; prompt_path: string }
    expect(child.parent_run_id).toBe(id)
    expect(readFileSync(child.prompt_path, 'utf8')).toContain(`yes ${questions[0]!.id}`)
  })

  test('answer refuses questions split between live and stopped owners', async () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'orch-test-session' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2 })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    const addQuestion = db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
    addQuestion.run(root, new Date().toISOString(), 'root question?')
    addQuestion.run(child, new Date().toISOString(), 'child question?')
    await expect(answerRun(root, { argv: ['one', 'two'], recordOnly: false, flags }, helpers))
      .rejects.toThrow('both live and stopped turns')
    expect(db().query('SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL').get()).toEqual({ n: 0 })
  })

  test('a stopped run without a vendor session keeps its question open', async () => {
    const id = insert('stopped', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still answerable?')
    await expect(answerRun(id, { argv: ['yes'], recordOnly: false, flags }, helpers))
      .rejects.toThrow('invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned')
    expect(db().query('SELECT answer,answered_by,answered_at FROM question WHERE run_id=?').get(id))
      .toEqual({ answer: null, answered_by: null, answered_at: null })
  })

  test('answer refuses a terminal or voided chain without writing', async () => {
    for (const { status, excluded } of [
      { status: 'failed', excluded: null }, { status: 'stopped', excluded: null },
      { status: 'stale', excluded: null }, { status: 'asking', excluded: 'voided with orch score --void' },
    ]) {
      const id = addRun({ agent: 'missing-test-agent', job: 'implement', status, session: 'orch-test-session' })
      if (excluded) db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run(excluded, id)
      db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, new Date().toISOString(), `${status} question?`)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      await expect(answerRun(id, { argv: [`${status} ruling`], recordOnly: false, flags }, helpers))
        .rejects.toThrow('invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned')
      expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({ answer: null })
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    }
  })
})
