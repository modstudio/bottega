import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from '../cli/args.ts'
import { rulingPrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { packedResumePrompt } from './run.ts'
import { answerRun, retryRun } from './run-answer.ts'
import { continueRun } from './run-control.ts'

const trackResidue = trackedTestResidue()

const presentation = {
  dur: (ms: number | null | undefined) => String(ms ?? 0),
  scoreHint: () => '',
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  printRunId: () => {},
}
const helpers = {
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation,
}
const flags = { detach: true, follow: false, quiet: true }
const retry = (id: number, options: { agent?: string; model?: string } = {}) =>
  retryRun(id, { ...options, flags }, helpers)

function insert(status: string, job = 'file-question'): number {
  return (
    db()
      .query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
      )
      .get(new Date().toISOString(), job, status) as { id: number }
  ).id
}

const priorEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.ORCH_DEPTH = process.env.ORCH_DEPTH
  priorEnv.ORCH_EXEC_PATH = process.env.ORCH_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  process.env.ORCH_DEPTH = '0'
  process.env.ORCH_EXEC_PATH = '/usr/bin/true'
})
afterEach(() => {
  if (priorEnv.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorEnv.CLAUDE_CODE_SESSION_ID
  if (priorEnv.ORCH_DEPTH === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorEnv.ORCH_DEPTH
  if (priorEnv.ORCH_EXEC_PATH === undefined) delete process.env.ORCH_EXEC_PATH
  else process.env.ORCH_EXEC_PATH = priorEnv.ORCH_EXEC_PATH
})

describe('run answers', () => {
  test('record-only closes the question, marks the chain stranded, and retry restates the ruling', async () => {
    const id = insert('asking')
    const prompt = trackResidue(join(dir, `record-only-${id}.txt`))
    writeFileSync(prompt, 'original fixture spec')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=?,prompt_path=?,cwd=? WHERE id=?')
      .run('orch-test-session', 'valid-session', prompt, dir, id)
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    await answerRun(id, { argv: ['use the existing shape'], recordOnly: true, flags }, helpers)
    expect(
      db().query('SELECT answer,delivery_pending_at FROM question WHERE run_id=?').get(id),
    ).toEqual({ answer: 'use the existing shape', delivery_pending_at: expect.any(String) })
    expect(
      rulingPrompt([{ question: 'which shape?', answer: 'use the existing shape' }]),
    ).toContain('THE RULING: use the existing shape')
  })
  test('answer refuses six individually-legal --file rulings whose packed resume exceeds argv', async () => {
    const id = insert('asking', 'implement')
    const spec = trackResidue(join(dir, `answer-six-large-${id}.prompt.txt`))
    writeFileSync(spec, 'original implementation spec')
    db()
      .query('UPDATE run SET vendor_session=?, prompt_path=?, session_id=? WHERE id=?')
      .run('parent-session', spec, 'orch-test-session', id)
    const body = 'x'.repeat(190_000)
    for (let i = 1; i <= 6; i++)
      db()
        .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, new Date().toISOString(), `q${i}?`)
    const questions = db()
      .query('SELECT id, question FROM question WHERE run_id=? ORDER BY id')
      .all(id) as { id: number; question: string }[]
    const argv: string[] = []
    for (const question of questions) {
      const path = trackResidue(join(dir, `answer-large-${question.id}.txt`))
      writeFileSync(path, body)
      argv.push(`--q${question.id}`, '--file', path)
    }
    const assembled = Buffer.byteLength(
      packedResumePrompt(
        'implement',
        rulingPrompt(questions.map((q) => ({ question: q.question, answer: body }))),
        id,
      ),
    )
    await expect(answerRun(id, { argv, recordOnly: false, flags }, helpers)).rejects.toThrow(
      `assembled resume prompt is ${assembled} bytes`,
    )
    expect(db().query('SELECT answer FROM question WHERE run_id=?').all(id)).toEqual(
      questions.map(() => ({ answer: null })),
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id)).toEqual({ n: 0 })
  })

  test('answer refuses questions split between live and stopped owners', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'orch-test-session',
    })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    const addQuestion = db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    )
    addQuestion.run(root, new Date().toISOString(), 'root question?')
    addQuestion.run(child, new Date().toISOString(), 'child question?')
    await expect(
      answerRun(root, { argv: ['one', 'two'], recordOnly: false, flags }, helpers),
    ).rejects.toThrow('both live and stopped turns')
    expect(
      db().query('SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL').get(),
    ).toEqual({ n: 0 })
  })

  test('a stopped run without a vendor session keeps its question open', async () => {
    const id = insert('stopped', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still answerable?')
    await expect(
      answerRun(id, { argv: ['yes'], recordOnly: false, flags }, helpers),
    ).rejects.toThrow(
      'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned',
    )
    expect(
      db().query('SELECT answer,answered_by,answered_at FROM question WHERE run_id=?').get(id),
    ).toEqual({ answer: null, answered_by: null, answered_at: null })
  })

  test('answer refuses a terminal or voided chain without writing', async () => {
    for (const { status, excluded } of [
      { status: 'failed', excluded: null },
      { status: 'stopped', excluded: null },
      { status: 'stale', excluded: null },
      { status: 'asking', excluded: 'voided with orch score --void' },
    ]) {
      const id = addRun({
        agent: 'missing-test-agent',
        job: 'implement',
        status,
        session: 'orch-test-session',
      })
      if (excluded) db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run(excluded, id)
      db()
        .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, new Date().toISOString(), `${status} question?`)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      await expect(
        answerRun(id, { argv: [`${status} ruling`], recordOnly: false, flags }, helpers),
      ).rejects.toThrow(
        'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned',
      )
      expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
        answer: null,
      })
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    }
  })
})

test('answer says an existing ruling stuck and reports the current status', async () => {
  const id = insert('failed', 'implement')
  db()
    .query('INSERT INTO question (run_id,question,answer,asked_at,answered_at) VALUES (?,?,?,?,?)')
    .run(id, 'which way?', 'the ruled way', new Date().toISOString(), new Date().toISOString())
  await expect(
    answerRun(id, { argv: ['again'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('has already been ruled on')
})

test('answer delivers a child turn live ruling without resuming the root', async () => {
  const root = insert('running', 'implement')
  const child = insert('running', 'implement')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', root)
  db().query('UPDATE run SET parent_run_id=?,turn=2,pid=? WHERE id=?').run(root, process.pid, child)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, new Date().toISOString(), 'which shape?')
  await answerRun(root, { argv: ['the direct shape'], recordOnly: false, flags }, helpers)
  expect(
    db().query('SELECT answer,delivery_pending_at FROM question WHERE run_id=?').get(child),
  ).toEqual({ answer: 'the direct shape', delivery_pending_at: null })
  expect(
    db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=? AND turn=3').get(root),
  ).toEqual({ n: 0 })
})

test('answer reads a ruling from a file without shell interpretation', async () => {
  const id = insert('asking')
  const path = trackResidue(join(dir, `ruling-${id}.txt`))
  writeFileSync(path, 'use $(literal) exactly')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: 'use $(literal) exactly',
  })
})

test('answer reads a ruling from stdin without shell interpretation', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  const stdinHelpers = {
    ...helpers,
    readMessageText: (options: Parameters<typeof readMessageText>[0]) =>
      readMessageText(options, {
        isTTY: false,
        bytes: async () => new TextEncoder().encode('stdin $(literal)'),
      }),
  }
  await answerRun(id, { argv: [], recordOnly: true, flags }, stdinHelpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: 'stdin $(literal)',
  })
})

test('answer --q<id> --file reads the file and never stores the flag name', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  const q = (
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
      .get(id, new Date().toISOString(), 'which?') as { id: number }
  ).id
  const path = trackResidue(join(dir, `q-${q}.txt`))
  writeFileSync(path, 'file ruling')
  await answerRun(id, { argv: [`--q${q}`, '--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE id=?').get(q)).toEqual({
    answer: 'file ruling',
  })
})

test('a ruling of --file alone is refused and not stored', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['--file'], recordOnly: true, flags }, helpers),
  ).rejects.toThrow()
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({ answer: null })
})

test('a ruling containing backticks and command substitution is stored byte-for-byte from --file', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  const path = trackResidue(join(dir, `shell-${id}.txt`))
  const ruling = '`echo literal` and $(still literal)'
  writeFileSync(path, ruling)
  await answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: ruling,
  })
})

test('multi-question answer mixes positional --q text with per-question --file', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    'INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id',
  )
  const first = (add.get(id, new Date().toISOString(), 'one?') as { id: number }).id
  const second = (add.get(id, new Date().toISOString(), 'two?') as { id: number }).id
  const path = trackResidue(join(dir, `multi-${id}.txt`))
  writeFileSync(path, 'second ruling')
  await answerRun(
    id,
    {
      argv: [`--q${first}`, 'first ruling', `--q${second}`, '--file', path],
      recordOnly: true,
      flags,
    },
    helpers,
  )
  expect(db().query('SELECT answer FROM question WHERE run_id=? ORDER BY id').all(id)).toEqual([
    { answer: 'first ruling' },
    { answer: 'second ruling' },
  ])
})

test('a multi-word positional ruling is stored whole, not just the first word', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['all', 'the', 'words'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: 'all the words',
  })
})

test('a two-word message beginning with -- is accepted as a ruling', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['--literal', 'value'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: '--literal value',
  })
})

test('a --q naming a question that is not open on this chain refuses the whole command', async () => {
  const id = insert('asking')
  const other = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id IN (?,?)')
    .run('orch-test-session', 'vendor', id, other)
  const own = (
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
      .get(id, new Date().toISOString(), 'own?') as { id: number }
  ).id
  const foreign = (
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
      .get(other, new Date().toISOString(), 'foreign?') as { id: number }
  ).id
  await expect(
    answerRun(
      id,
      { argv: [`--q${own}`, 'yes', `--q${foreign}`, 'no'], recordOnly: true, flags },
      helpers,
    ),
  ).rejects.toThrow('belongs to run')
  expect(db().query('SELECT answer FROM question WHERE id=?').get(own)).toEqual({ answer: null })
})

test('a closed or duplicate --q refuses the whole command', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  const q = (
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id')
      .get(id, new Date().toISOString(), 'own?') as { id: number }
  ).id
  await expect(
    answerRun(
      id,
      { argv: [`--q${q}`, 'yes', `--q${q}`, 'again'], recordOnly: true, flags },
      helpers,
    ),
  ).rejects.toThrow('more than once')
  expect(db().query('SELECT answer FROM question WHERE id=?').get(q)).toEqual({ answer: null })
})

test('answer --file refuses invalid UTF-8 at the byte offset', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  const path = trackResidue(join(dir, `invalid-${id}.txt`))
  writeFileSync(path, new Uint8Array([0x61, 0xff]))
  await expect(
    answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('byte offset 1')
})

test('answer stdin refuses invalid UTF-8 at the byte offset', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  const stdinHelpers = {
    ...helpers,
    readMessageText: (options: Parameters<typeof readMessageText>[0]) =>
      readMessageText(options, { isTTY: false, bytes: async () => new Uint8Array([0x61, 0xff]) }),
  }
  await expect(answerRun(id, { argv: [], recordOnly: true, flags }, stdinHelpers)).rejects.toThrow(
    'byte offset 1',
  )
})

test('answer keeps flag-shaped words after the message starts', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['use', '--file', 'literally'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({
    answer: 'use --file literally',
  })
})

test('answer stdin refuses whitespace-only input', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  const stdinHelpers = {
    ...helpers,
    readMessageText: (options: Parameters<typeof readMessageText>[0]) =>
      readMessageText(options, {
        isTTY: false,
        bytes: async () => new TextEncoder().encode('   \n'),
      }),
  }
  await expect(answerRun(id, { argv: [], recordOnly: true, flags }, stdinHelpers)).rejects.toThrow(
    'empty ruling',
  )
})

test('a partial multi-question ruling names the single-command rule', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    'INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?) RETURNING id',
  )
  const first = (add.get(id, new Date().toISOString(), 'one?') as { id: number }).id
  add.get(id, new Date().toISOString(), 'two?')
  await expect(
    answerRun(id, { argv: [`--q${first}`, 'yes'], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('single command')
  expect(db().query('SELECT answer FROM question WHERE run_id=?').all(id)).toEqual([
    { answer: null },
    { answer: null },
  ])
})

test('a leaf id answers the open question in its conversation', async () => {
  const root = insert('running', 'implement')
  const child = insert('running', 'implement')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE id=?')
    .run('orch-test-session', 'vendor', root)
  db().query('UPDATE run SET parent_run_id=?,turn=2,pid=? WHERE id=?').run(root, process.pid, child)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, new Date().toISOString(), 'which?')
  await answerRun(child, { argv: ['the existing shape'], recordOnly: false, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(child)).toEqual({
    answer: 'the existing shape',
  })
})

test('answer rejects a fixture ruling from a non-owning session without writing it', async () => {
  const id = insert('asking', 'implement')
  db().query('UPDATE run SET session_id=? WHERE id=?').run('owning-session', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['foreign ruling'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('owned by session owning-session')
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({ answer: null })
})

test('answer permits an unowned question, warns, and records the answering session', async () => {
  const id = insert('running', 'implement')
  db().query('UPDATE run SET session_id=NULL,pid=? WHERE id=?').run(process.pid, id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['the existing shape'], recordOnly: false, flags }, helpers)
  expect(db().query('SELECT answer,answered_by FROM question WHERE run_id=?').get(id)).toEqual({
    answer: 'the existing shape',
    answered_by: 'orch-test-session',
  })
  expect(db().query('SELECT session_id FROM run WHERE id=?').get(id)).toEqual({
    session_id: 'orch-test-session',
  })
})

test('answer refuses an asking run with no vendor session without recording the ruling', async () => {
  const id = insert('asking', 'implement')
  db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['use the existing shape'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('cannot be resumed: no vendor session')
  expect(db().query('SELECT answer FROM question WHERE run_id=?').get(id)).toEqual({ answer: null })
})

describe('retry command', () => {
  const failed = (job = 'file-question') => {
    const id = addRun({ agent: 'grok', job, status: 'failed' })
    const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
    writeFileSync(prompt, 'What does bar.ts do?')
    db()
      .query('UPDATE run SET prompt_path=?,cwd=?,session_id=? WHERE id=?')
      .run(prompt, dir, 'orch-test-session', id)
    return id
  }

  test('bridge-only identity cannot retry an unowned read-only run', async () => {
    const id = failed()
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
    await expect(retry(id)).rejects.toThrow(
      `run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`,
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE retry_of=?').get(id)).toEqual({ n: 0 })
  })

  test('retry refuses a foreign owner before either job shape launches', async () => {
    for (const job of ['file-question', 'implement']) {
      const id = failed(job)
      db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)
      process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
      await expect(retry(id)).rejects.toThrow(`run ${id} is owned by session owner-session`)
      expect(
        db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=? OR retry_of=?').get(id, id),
      ).toEqual({ n: 0 })
    }
  })

  test('a writing retry refuses to change agents and directs a fresh start', async () => {
    const id = failed('implement')
    db().query("UPDATE run SET vendor_session='retry-session' WHERE id=?").run(id)
    await expect(retry(id, { agent: 'codex' })).rejects.toThrow(
      'a writing run continues on its own agent (grok); to start over on codex: orch do implement --agent codex ...',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id)).toEqual({ n: 0 })
  })

  test('retry and continue give the same refusal when the chain has no session', async () => {
    for (const command of ['retry', 'continue'] as const) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
      const prompt = trackResidue(join(dir, `no-session-${id}.prompt.txt`))
      writeFileSync(prompt, 'continue')
      db()
        .query('UPDATE run SET prompt_path=?,cwd=?,session_id=?,vendor_session=NULL WHERE id=?')
        .run(prompt, dir, 'orch-test-session', id)
      const action =
        command === 'retry' ? retry(id) : continueRun(id, 'go', helpers.argvResumeLimit)
      await expect(action).rejects.toThrow(
        `run ${id} recorded no session id, so codex cannot be resumed`,
      )
    }
  })
})
