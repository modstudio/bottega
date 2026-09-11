import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARGV_PROMPT_BYTES, addRun, db, dir, packedResumePrompt, rulingPrompt } from '../test/fixture.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from './args.ts'
import { answerRun, retryRun } from './run-answer.ts'
import { scriptedTransport } from '../test/fake-transport.ts'

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
  test('record-only closes the question, marks the chain stranded, and retry restates the ruling', async () => {
    const id = insert('asking'); const prompt = join(dir, `record-only-${id}.txt`); writeFileSync(prompt, 'original fixture spec')
    db().query('UPDATE run SET session_id=?,vendor_session=?,prompt_path=?,cwd=? WHERE id=?').run('orch-test-session', 'valid-session', prompt, dir, id)
    db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(id, new Date().toISOString(), 'which shape?')
    await answerRun(id, { argv: ['use the existing shape'], recordOnly: true, flags }, helpers)
    expect(db().query('SELECT answer,delivery_pending_at FROM question WHERE run_id=?').get(id)).toEqual({ answer: 'use the existing shape', delivery_pending_at: expect.any(String) })
    const fake = scriptedTransport([{ kind: 'completed', output: 'done' }]); fake.install()
    await retryRun(id, { flags, agent: 'codex' }, helpers)
    expect(fake.prompts.join('\n')).toContain('THE RULING: use the existing shape')
  })

  test('retry through a child delivers a pending ruling from a non-asking stranded root', async () => {
    const root = insert('failed'); const child = insert('failed'); const prompt = join(dir, `retry-child-${child}.txt`); writeFileSync(prompt, 'original')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root); db().query('UPDATE run SET parent_run_id=?,turn=2,prompt_path=?,cwd=? WHERE id=?').run(root, prompt, dir, child)
    db().query('INSERT INTO question (run_id,asked_at,question,answer,answered_at,answered_by,delivery_pending_at) VALUES (?,?,?,?,?,?,?)').run(child, new Date().toISOString(), 'which recovery?', 'retry with ruling', new Date().toISOString(), 'orch-test-session', new Date().toISOString())
    const fake = scriptedTransport([{ kind: 'completed', output: 'done' }]); fake.install(); await retryRun(child, { flags, agent: 'codex' }, helpers)
    expect(fake.prompts.join('\n')).toContain('THE RULING: retry with ruling'); expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(child)).toEqual({ delivery_pending_at: null })
  })

  test('a recorded-ruling writing retry warns that prior partial edits are not carried', async () => {
    const id = insert('asking', 'implement'); const prompt = join(dir, `writing-retry-${id}.txt`); writeFileSync(prompt, 'spec'); db().query('UPDATE run SET session_id=?,vendor_session=?,prompt_path=?,cwd=? WHERE id=?').run('orch-test-session', 'valid', prompt, dir, id)
    db().query('INSERT INTO question (run_id,asked_at,question,answer,answered_at,answered_by,delivery_pending_at) VALUES (?,?,?,?,?,?,?)').run(id, new Date().toISOString(), 'shape?', 'existing', new Date().toISOString(), 'orch-test-session', new Date().toISOString())
    const errors: string[] = []; const prior = console.error; console.error = (...parts) => errors.push(parts.join(' '))
    try { await expect(retryRun(id, { flags }, helpers)).rejects.toThrow() } finally { console.error = prior }
    expect(errors.join('\n')).toContain('retry will not carry the previous partial edit')
  })

  test('answer resumes the agent from the same row as the fallback vendor session', async () => {
    const root = insert('asking'); db().query('UPDATE run SET session_id=?,vendor_session=?,agent=?,cwd=? WHERE id=?').run('orch-test-session', 'codex-session', 'codex', dir, root)
    const latest = insert('asking'); db().query('UPDATE run SET parent_run_id=?,turn=2,vendor_session=NULL,agent=?,cwd=? WHERE id=?').run(root, 'grok', dir, latest); db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(latest, new Date().toISOString(), 'which shape?')
    const fake = scriptedTransport([{ kind: 'completed', output: 'done' }]); fake.install(); await answerRun(root, { argv: ['existing'], recordOnly: false, flags }, helpers)
    expect(db().query('SELECT agent,vendor_session FROM run WHERE parent_run_id=? AND turn=3').get(root)).toEqual({ agent: 'codex', vendor_session: 'codex-session' })
  })

  test('a resume spawn failure rolls the ruling back and leaves the question open', async () => {
    const id = insert('asking', 'implement'); db().query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?').run('orch-test-session', 'vendor', id); db().query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)').run(id, new Date().toISOString(), 'which shape?')
    process.env.ORCH_EXEC_PATH = join(dir, 'definitely-missing-exec')
    await expect(answerRun(id, { argv: ['existing'], recordOnly: false, flags }, helpers)).rejects.toThrow()
    expect(db().query('SELECT answer,answered_at FROM question WHERE run_id=?').get(id)).toEqual({ answer: null, answered_at: null })
  })
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
