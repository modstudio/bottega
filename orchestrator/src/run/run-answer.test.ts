import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFromArgv as answerRun,
  answerRunFlags as flags,
  answerRunHelpers as helpers,
  insertRun as insert,
  newQuestionSql,
  retryRunFromFixture as retry,
  returningQuestionSql,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { readMessageText } from '../cli/args.ts'
import { rulingPrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { retryRun } from './run-answer.ts'
import type { detach } from './run-dispatch.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'

const trackResidue = trackedTestResidue()

const priorEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.BOTTEGA_DEPTH = process.env.BOTTEGA_DEPTH
  priorEnv.BOTTEGA_EXEC_PATH = process.env.BOTTEGA_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.BOTTEGA_DEPTH
  process.env.BOTTEGA_EXEC_PATH = '/usr/bin/true'
})
afterEach(() => {
  if (priorEnv.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorEnv.CLAUDE_CODE_SESSION_ID
  if (priorEnv.BOTTEGA_DEPTH === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = priorEnv.BOTTEGA_DEPTH
  if (priorEnv.BOTTEGA_EXEC_PATH === undefined) delete process.env.BOTTEGA_EXEC_PATH
  else process.env.BOTTEGA_EXEC_PATH = priorEnv.BOTTEGA_EXEC_PATH
})

describe('run answers', () => {
  test('record-only closes the question, marks the chain stranded, and retry restates the ruling', async () => {
    const id = insert('asking')
    const prompt = trackResidue(join(dir, `record-only-${id}.txt`))
    writeFileSync(prompt, 'original fixture spec')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=?,prompt_path=?,cwd=? WHERE record_id=?')
      .run('orch-test-session', 'valid-session', prompt, dir, id)
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question,awaiting_operator_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?)`,
      )
      .run(id, new Date().toISOString(), 'which shape?', new Date().toISOString())
    await answerRun(
      id,
      { argv: ['use the existing shape', '--channel', 'mcp'], recordOnly: true, flags },
      helpers,
    )
    expect(
      db()
        .query(
          `SELECT answer,answerer_kind,answer_channel,delivery_pending_at,awaiting_operator_at
             FROM question WHERE run_record_id=?`,
        )
        .get(id),
    ).toEqual({
      answer: 'use the existing shape',
      answerer_kind: 'agent',
      answer_channel: 'mcp',
      delivery_pending_at: expect.any(String),
      awaiting_operator_at: null,
    })
    expect(
      db()
        .query(
          'SELECT run_record_id,mode,outcome,error FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)',
        )
        .get(id),
    ).toEqual({ run_record_id: null, mode: 'record-only', outcome: 'delivered', error: null })
    expect(
      rulingPrompt([{ question: 'which shape?', answer: 'use the existing shape' }]),
    ).toContain('THE RULING: use the existing shape')
  })

  test('resume records the new turn that received the ruling', async () => {
    const id = insert('asking')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
      .run('orch-test-session', 'vendor', id)
    db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which shape?')
    let childId = ''
    const dispatch: typeof detach = async (_job, _prompt, spec) => {
      childId = addRun({
        agent: spec.resume!.agent,
        job: 'file-question',
        status: 'running',
        parent: spec.resume!.parent,
        turn: spec.resume!.turn,
      })
      return childId
    }
    await answerRun(
      id,
      { argv: ['use the existing shape'], recordOnly: false, flags },
      { ...helpers, dispatch },
    )
    expect(
      db()
        .query(
          'SELECT run_record_id,mode,outcome,error FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)',
        )
        .get(id),
    ).toEqual({ run_record_id: childId, mode: 'resume', outcome: 'delivered', error: null })
  })

  test('failed resume keeps its delivery failure after reopening the question', async () => {
    const id = insert('asking', 'file-question', '01990000-0000-7000-8000-000000000042')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
      .run('orch-test-session', 'vendor', id)
    db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which shape?')
    const dispatch: typeof detach = async () => {
      throw new Error('fixture dispatch failed')
    }
    await expect(
      answerRun(
        id,
        { argv: ['use the existing shape'], recordOnly: false, flags },
        { ...helpers, dispatch },
      ),
    ).rejects.toThrow('Resume failed: fixture dispatch failed')
    expect(
      db()
        .query(
          `SELECT answer,answered_at,answered_by,answerer_kind,answer_channel,delivery_pending_at,revision
             FROM question WHERE run_record_id=?`,
        )
        .get(id),
    ).toEqual({
      answer: null,
      answered_at: null,
      answered_by: null,
      answerer_kind: null,
      answer_channel: null,
      delivery_pending_at: null,
      revision: 3,
    })
    const pending = db()
      .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
      .get()!
    expect(JSON.parse(pending.payload)).toMatchObject({
      answer: null,
      answeredAt: null,
      revision: 3,
    })
    expect(
      db()
        .query(
          'SELECT run_record_id,mode,outcome,error FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE run_record_id=?)',
        )
        .get(id),
    ).toEqual({
      run_record_id: null,
      mode: 'resume',
      outcome: 'failed',
      error: 'fixture dispatch failed',
    })
  })

  test('failed resume emits a newer withdrawal after an answer already synced', async () => {
    const id = insert('asking', 'file-question', '01990000-0000-7000-8000-000000000043')
    db()
      .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
      .run('orch-test-session', 'vendor', id)
    db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which shape?')
    const dispatch: typeof detach = async () => {
      db()
        .query("UPDATE outbox SET synced_at='2026-09-25T12:00:00.000Z' WHERE kind='question'")
        .run()
      throw new Error('fixture dispatch failed after sync')
    }

    await expect(
      answerRun(
        id,
        { argv: ['use the existing shape'], recordOnly: false, flags },
        { ...helpers, dispatch },
      ),
    ).rejects.toThrow('Resume failed: fixture dispatch failed after sync')

    const payloads = db()
      .query<{ payload: string }, []>(
        "SELECT payload FROM outbox WHERE kind='question' ORDER BY id",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as { answer: string | null; revision: number })
    expect(payloads).toEqual([
      expect.objectContaining({ answer: 'use the existing shape', revision: 2 }),
      expect.objectContaining({ answer: null, revision: 3 }),
    ])
  })
  test('answer refuses six individually-legal --file rulings whose packed resume exceeds argv', async () => {
    const id = insert('asking', 'implement')
    const spec = trackResidue(join(dir, `answer-six-large-${id}.prompt.txt`))
    writeFileSync(spec, 'original implementation spec')
    db()
      .query('UPDATE run SET vendor_session=?, prompt_path=?, session_id=? WHERE record_id=?')
      .run('parent-session', spec, 'orch-test-session', id)
    const body = 'x'.repeat(190_000)
    for (let i = 1; i <= 6; i++)
      db().query(newQuestionSql()).run(id, new Date().toISOString(), `q${i}?`)
    const questions = db()
      .query('SELECT number, question FROM question WHERE run_record_id=? ORDER BY number')
      .all(id) as { number: number; question: string }[]
    const argv: string[] = []
    for (const question of questions) {
      const path = trackResidue(join(dir, `answer-large-${question.number}.txt`))
      writeFileSync(path, body)
      argv.push(`--q${question.number}`, '--file', path)
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
    expect(db().query('SELECT answer FROM question WHERE run_record_id=?').all(id)).toEqual(
      questions.map(() => ({ answer: null })),
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(id)).toEqual({
      n: 0,
    })
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
    db().query('UPDATE run SET pid=? WHERE record_id=?').run(process.pid, child)
    const addQuestion = db().query(
      `INSERT INTO question (number,record_id,run_record_id, asked_at, question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?)`,
    )
    addQuestion.run(newRecordId(), root, new Date().toISOString(), 'root question?')
    addQuestion.run(newRecordId(), child, new Date().toISOString(), 'child question?')
    await expect(
      answerRun(root, { argv: ['one', 'two'], recordOnly: false, flags }, helpers),
    ).rejects.toThrow('both live and stopped turns')
    expect(
      db().query('SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL').get(),
    ).toEqual({ n: 0 })
  })

  test('a stopped run without a vendor session keeps its question open', async () => {
    const id = insert('stopped', 'implement')
    db().query('UPDATE run SET session_id=? WHERE record_id=?').run('orch-test-session', id)
    db().query(newQuestionSql()).run(id, new Date().toISOString(), 'still answerable?')
    await expect(
      answerRun(id, { argv: ['yes'], recordOnly: false, flags }, helpers),
    ).rejects.toThrow(
      'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned',
    )
    expect(
      db()
        .query('SELECT answer,answered_by,answered_at FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answer: null, answered_by: null, answered_at: null })
  })

  test('answer refuses a terminal or voided chain without writing', async () => {
    for (const { status, excluded } of [
      { status: 'failed', excluded: null },
      { status: 'stopped', excluded: null },
      { status: 'stale', excluded: null },
      { status: 'asking', excluded: VOID_EXCLUSION_REASON },
    ]) {
      const id = addRun({
        agent: 'missing-test-agent',
        job: 'implement',
        status,
        session: 'orch-test-session',
      })
      if (excluded)
        db().query('UPDATE run SET evidence_excluded=? WHERE record_id=?').run(excluded, id)
      db().query(newQuestionSql()).run(id, new Date().toISOString(), `${status} question?`)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      await expect(
        answerRun(id, { argv: [`${status} ruling`], recordOnly: false, flags }, helpers),
      ).rejects.toThrow(
        'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned',
      )
      expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
        answer: null,
      })
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    }
  })
})

test('answer says an existing ruling stuck and reports the current status', async () => {
  const id = insert('failed', 'implement')
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,question,answer,asked_at,answered_at) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?)`,
    )
    .run(id, 'which way?', 'the ruled way', new Date().toISOString(), new Date().toISOString())
  await expect(
    answerRun(id, { argv: ['again'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('has already been ruled on')
})

test('answer delivers an asking child ruling under an ok root without resuming the root', async () => {
  const root = insert('ok', 'implement')
  const child = insert('asking', 'implement')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', root)
  db()
    .query('UPDATE run SET parent_run_record_id=?,turn=2,pid=? WHERE record_id=?')
    .run(root, process.pid, child)
  db().query(newQuestionSql()).run(child, new Date().toISOString(), 'which shape?')
  await answerRun(root, { argv: ['the direct shape'], recordOnly: false, flags }, helpers)
  expect(
    db().query('SELECT answer,delivery_pending_at FROM question WHERE run_record_id=?').get(child),
  ).toEqual({ answer: 'the direct shape', delivery_pending_at: null })
  expect(
    db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=? AND turn=3').get(root),
  ).toEqual({ n: 0 })
})

test('answer reads a ruling from a file without shell interpretation', async () => {
  const id = insert('asking')
  const path = trackResidue(join(dir, `ruling-${id}.txt`))
  writeFileSync(path, 'use $(literal) exactly')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: 'use $(literal) exactly',
  })
})

test('answer reads a ruling from stdin without shell interpretation', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  const stdinHelpers = {
    ...helpers,
    readMessageText: (options: Parameters<typeof readMessageText>[0]) =>
      readMessageText(options, {
        isTTY: false,
        bytes: async () => new TextEncoder().encode('stdin $(literal)'),
      }),
  }
  await answerRun(id, { argv: [], recordOnly: true, flags }, stdinHelpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: 'stdin $(literal)',
  })
})

test('answer --q<id> --file reads the file and never stores the flag name', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const q = (
    db().query(returningQuestionSql()).get(id, new Date().toISOString(), 'which?') as {
      number: number
    }
  ).number
  const path = trackResidue(join(dir, `q-${q}.txt`))
  writeFileSync(path, 'file ruling')
  await answerRun(id, { argv: [`--q${q}`, '--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE number=?').get(q)).toEqual({
    answer: 'file ruling',
  })
})

test('a ruling of --file alone is refused and not stored', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['--file'], recordOnly: true, flags }, helpers),
  ).rejects.toThrow()
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: null,
  })
})

test('a ruling containing backticks and command substitution is stored byte-for-byte from --file', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  const path = trackResidue(join(dir, `shell-${id}.txt`))
  const ruling = '`echo literal` and $(still literal)'
  writeFileSync(path, ruling)
  await answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: ruling,
  })
})

test('multi-question answer mixes positional --q text with per-question --file', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?) RETURNING number`,
  )
  const first = (
    add.get(newRecordId(), id, new Date().toISOString(), 'one?') as {
      number: number
    }
  ).number
  const second = (
    add.get(newRecordId(), id, new Date().toISOString(), 'two?') as {
      number: number
    }
  ).number
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
  expect(
    db().query('SELECT answer FROM question WHERE run_record_id=? ORDER BY number').all(id),
  ).toEqual([{ answer: 'first ruling' }, { answer: 'second ruling' }])
})

test('multi-question answer attributes only the per-question operator ruling', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?) RETURNING number`,
  )
  const agent = add.get(newRecordId(), id, new Date().toISOString(), 'agent?') as {
    number: number
  }
  const operator = add.get(newRecordId(), id, new Date().toISOString(), 'operator?') as {
    number: number
  }

  await answerRun(
    id,
    {
      argv: [
        `--q${agent.number}`,
        'Agent ruling.',
        `--from-operator-q${operator.number}`,
        `--q${operator.number}`,
        'Operator ruling.',
      ],
      recordOnly: true,
      flags,
    },
    helpers,
  )

  expect(
    db()
      .query('SELECT answer,answerer_kind FROM question WHERE run_record_id=? ORDER BY number')
      .all(id),
  ).toEqual([
    { answer: 'Agent ruling.', answerer_kind: 'agent' },
    { answer: 'Operator ruling.', answerer_kind: 'operator' },
  ])
})

test('a UUID selector answers only the named question', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?) RETURNING number,record_id`,
  )
  const first = add.get(newRecordId(), id, new Date().toISOString(), 'one?') as {
    number: number
    record_id: string
  }
  const second = add.get(newRecordId(), id, new Date().toISOString(), 'two?') as {
    number: number
    record_id: string
  }
  await answerRun(
    id,
    { argv: [`--q${second.record_id}`, 'second only'], recordOnly: true, flags },
    helpers,
  )
  expect(
    db().query('SELECT number,answer FROM question WHERE run_record_id=? ORDER BY number').all(id),
  ).toEqual([
    { number: first.number, answer: null },
    { number: second.number, answer: 'second only' },
  ])
})

test('malformed and unknown UUID question selectors refuse without writing', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['--qnot-an-id', 'no'], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('invalid question identifier')
  await expect(
    answerRun(
      id,
      {
        argv: ['--q01990000-0000-7000-8000-000000000099', 'no'],
        recordOnly: true,
        flags,
      },
      helpers,
    ),
  ).rejects.toThrow('no question has UUID')
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: null,
  })
})

test('a multi-word positional ruling is stored whole, not just the first word', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['all', 'the', 'words'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: 'all the words',
  })
})

test('a two-word message beginning with -- is accepted as a ruling', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['--literal', 'value'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: '--literal value',
  })
})

test('a --q naming a question that is not open on this chain refuses the whole command', async () => {
  const id = insert('asking')
  const other = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id IN (?,?)')
    .run('orch-test-session', 'vendor', id, other)
  const own = (
    db().query(returningQuestionSql()).get(id, new Date().toISOString(), 'own?') as {
      number: number
    }
  ).number
  const foreign = (
    db().query(returningQuestionSql()).get(other, new Date().toISOString(), 'foreign?') as {
      number: number
    }
  ).number
  await expect(
    answerRun(
      id,
      { argv: [`--q${own}`, 'yes', `--q${foreign}`, 'no'], recordOnly: true, flags },
      helpers,
    ),
  ).rejects.toThrow('belongs to run')
  expect(db().query('SELECT answer FROM question WHERE number=?').get(own)).toEqual({
    answer: null,
  })
})

test('a closed or duplicate --q refuses the whole command', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const q = (
    db().query(returningQuestionSql()).get(id, new Date().toISOString(), 'own?') as {
      number: number
    }
  ).number
  await expect(
    answerRun(
      id,
      { argv: [`--q${q}`, 'yes', `--q${q}`, 'again'], recordOnly: true, flags },
      helpers,
    ),
  ).rejects.toThrow('more than once')
  expect(db().query('SELECT answer FROM question WHERE number=?').get(q)).toEqual({ answer: null })
})

test('answer --file refuses invalid UTF-8 at the byte offset', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  const path = trackResidue(join(dir, `invalid-${id}.txt`))
  writeFileSync(path, new Uint8Array([0x61, 0xff]))
  await expect(
    answerRun(id, { argv: ['--file', path], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('byte offset 1')
})

test('answer stdin refuses invalid UTF-8 at the byte offset', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
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
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['use', '--file', 'literally'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: 'use --file literally',
  })
})

test('answer stdin refuses whitespace-only input', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
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

test('a partial numeric multi-question ruling names the single-command rule', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  const add = db().query(
    `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?) RETURNING number`,
  )
  const first = (
    add.get(newRecordId(), id, new Date().toISOString(), 'one?') as {
      number: number
    }
  ).number
  add.get(newRecordId(), id, new Date().toISOString(), 'two?')
  await expect(
    answerRun(id, { argv: [`--q${first}`, 'yes'], recordOnly: true, flags }, helpers),
  ).rejects.toThrow('single command')
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').all(id)).toEqual([
    { answer: null },
    { answer: null },
  ])
})

test('a leaf id answers the open question in its conversation', async () => {
  const root = insert('running', 'implement')
  const child = insert('running', 'implement')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', root)
  db()
    .query('UPDATE run SET parent_run_record_id=?,turn=2,pid=? WHERE record_id=?')
    .run(root, process.pid, child)
  db().query(newQuestionSql()).run(child, new Date().toISOString(), 'which?')
  await answerRun(child, { argv: ['the existing shape'], recordOnly: false, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(child)).toEqual({
    answer: 'the existing shape',
  })
})

test('answer rejects a fixture ruling from a non-owning session without writing it', async () => {
  const id = insert('asking', 'implement')
  db().query('UPDATE run SET session_id=? WHERE record_id=?').run('owning-session', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['foreign ruling'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('owned by session owning-session')
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: null,
  })
})

test('a plain operator answers a run whose owner is gone', async () => {
  const id = insert('asking', 'implement')
  db()
    .query('UPDATE run SET session_id=?,started_at=?,last_event_at=? WHERE record_id=?')
    .run('gone-owner', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  delete process.env.CLAUDE_CODE_SESSION_ID

  await answerRun(id, { argv: ['operator ruling'], recordOnly: true, flags }, helpers)
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: 'operator ruling',
  })
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(id)).toEqual({
    session_id: 'gone-owner',
  })
  expect(
    db().query('SELECT actor_session FROM run_mutation_audit WHERE run_record_id=?').get(id),
  ).toEqual({
    actor_session: expect.stringMatching(/^operator:/),
  })
})

test('UI operator answers require the dashboard capability', async () => {
  const id = insert('asking', 'implement')
  const question = db()
    .query(returningQuestionSql())
    .get(id, new Date().toISOString(), 'which?') as { number: number }
  delete process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.BOTTEGA_DEPTH
  await expect(
    answerRun(
      id,
      {
        argv: [`--q${question.number}`, 'use it', '--from-operator', '--channel', 'ui'],
        recordOnly: false,
        flags,
      },
      { ...helpers, dashboardAuthorized: () => false },
    ),
  ).rejects.toThrow('--channel ui requires the dashboard capability')
  expect(db().query('SELECT answer FROM question WHERE number=?').get(question.number)).toEqual({
    answer: null,
  })
})

test('UI operator answers a foreign-owned chain without adopting it and resumes under its owner', async () => {
  const id = insert('asking', 'implement')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('dispatching-session', 'vendor', id)
  const question = db()
    .query(returningQuestionSql())
    .get(id, new Date().toISOString(), 'which?') as { number: number }
  delete process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.BOTTEGA_DEPTH
  let resumedSession: string | null | undefined
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    resumedSession = spec.resume!.sessionId
    return addRun({
      agent: spec.resume!.agent,
      job: 'implement',
      status: 'running',
      parent: spec.resume!.parent,
      turn: spec.resume!.turn,
      session: spec.resume!.sessionId,
    })
  }
  const result = await answerRun(
    id,
    {
      argv: [
        `--q${question.number}`,
        'use the existing shape',
        '--from-operator',
        '--channel',
        'ui',
      ],
      recordOnly: false,
      json: true,
      flags,
    },
    { ...helpers, dispatch, dashboardAuthorized: () => true },
  )
  const resumedRecordId = result.resumed_record_id
  expect(resumedRecordId).toMatch(/^[0-9a-f-]{36}$/)
  expect(result).toMatchObject({
    outcome: 'resumed',
    run_record_id: id,
    run_number: expect.any(Number),
    resumed_record_id: resumedRecordId,
    resumed_number: expect.any(Number),
  })
  expect(resumedSession).toBe('dispatching-session')
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(id)).toEqual({
    session_id: 'dispatching-session',
  })
  expect(
    db()
      .query('SELECT answered_by,answerer_kind,answer_channel FROM question WHERE number=?')
      .get(question.number),
  ).toEqual({ answered_by: 'operator via hub', answerer_kind: 'operator', answer_channel: 'ui' })
  expect(
    db()
      .query(
        "SELECT actor_session,turn_run_record_id FROM run_mutation_audit WHERE root_run_record_id=? AND action='answer'",
      )
      .get(id),
  ).toEqual({ actor_session: 'operator:ui', turn_run_record_id: resumedRecordId })
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(resumedRecordId!)).toEqual({
    session_id: 'dispatching-session',
  })
})

test('answer permits an unowned question, warns, and records the answering session', async () => {
  const id = insert('running', 'implement')
  db().query('UPDATE run SET session_id=NULL,pid=? WHERE record_id=?').run(process.pid, id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await answerRun(id, { argv: ['the existing shape'], recordOnly: false, flags }, helpers)
  expect(
    db().query('SELECT answer,answered_by FROM question WHERE run_record_id=?').get(id),
  ).toEqual({
    answer: 'the existing shape',
    answered_by: 'orch-test-session',
  })
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(id)).toEqual({
    session_id: 'orch-test-session',
  })
})

test('answer refuses an asking run with no vendor session without recording the ruling', async () => {
  const id = insert('asking', 'implement')
  db().query('UPDATE run SET session_id=? WHERE record_id=?').run('orch-test-session', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')
  await expect(
    answerRun(id, { argv: ['use the existing shape'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('cannot be resumed: no vendor session')
  expect(db().query('SELECT answer FROM question WHERE run_record_id=?').get(id)).toEqual({
    answer: null,
  })
})

test('answer refuses a missing continuation checkout before recording the ruling', async () => {
  const id = insert('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=?,repo=NULL WHERE record_id=?')
    .run('orch-test-session', 'vendor-session', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which?')

  await expect(
    answerRun(id, { argv: ['use the existing shape'], recordOnly: false, flags }, helpers),
  ).rejects.toThrow('no available registered repository identity')
  expect(
    db().query('SELECT answer,delivery_pending_at FROM question WHERE run_record_id=?').get(id),
  ).toEqual({ answer: null, delivery_pending_at: null })
})

describe('retry command', () => {
  const failed = (job = 'file-question') => {
    const id = addRun({
      agent: 'grok',
      job,
      status: 'failed',
      repo: 'continuation-fixture',
    })
    const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
    writeFileSync(prompt, 'What does bar.ts do?')
    db()
      .query('UPDATE run SET prompt_path=?,cwd=?,session_id=? WHERE record_id=?')
      .run(prompt, dir, 'orch-test-session', id)
    return id
  }

  test('retry refuses lifecycle rows as non-agent work', async () => {
    const id = failed('landing-tree')

    await expect(retry(id)).rejects.toThrow(
      `run ${id} is a lifecycle row, not agent work; it cannot be retried. No action is needed because lifecycle rows are evidence-excluded`,
    )
  })

  test('bridge-only identity cannot retry an unowned read-only run', async () => {
    const id = failed()
    db().query('UPDATE run SET session_id=NULL WHERE record_id=?').run(id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
    await expect(retry(id)).rejects.toThrow(
      `run ${id} is unowned; this caller is an unsupported harness (`,
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE retry_of_record_id=?').get(id)).toEqual({
      n: 0,
    })
  })

  test('retry refuses a foreign owner before either job shape launches', async () => {
    for (const job of ['file-question', 'implement']) {
      const id = failed(job)
      db().query('UPDATE run SET session_id=? WHERE record_id=?').run('owner-session', id)
      process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
      await expect(retry(id)).rejects.toThrow(`run ${id} is owned by session owner-session`)
      expect(
        db()
          .query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=? OR retry_of_record_id=?')
          .get(id, id),
      ).toEqual({ n: 0 })
    }
  })

  test('retry refuses an asking chain and names its question and remedies', async () => {
    const id = failed('implement')
    db().query("UPDATE run SET status='asking' WHERE record_id=?").run(id)
    db().query(newQuestionSql()).run(id, new Date().toISOString(), 'Which retained shape?')
    await expect(retry(id, { agent: 'codex' })).rejects.toThrow(
      `run ${id} is asking with open questions: q`,
    )
    await expect(retry(id, { agent: 'codex' })).rejects.toThrow(
      `Answer them, or ${PLATFORM_SLUG} run abandon ${id}`,
    )
  })

  test('fresh retry refuses a continuation turn whose instructions are unrecoverable', async () => {
    const id = failed('implement')
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
    })

    await expect(retry(id, { agent: 'codex' })).rejects.toThrow(
      `run ${id} continuation turn ${child} has no recoverable continue instructions. ` +
        `Re-send the instructions with ${PLATFORM_SLUG} run continue ${id} --file <spec>, ` +
        `or pass ${PLATFORM_SLUG} run retry ${child} for that turn directly.`,
    )
  })

  test('a rejected retry dispatch records failed ruling delivery', async () => {
    const id = failed()
    const questionId = (
      db()
        .query(
          `INSERT INTO question
             (number,record_id,run_record_id, asked_at, question, answer, answered_at, delivery_pending_at)
           VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?,?,?) RETURNING number`,
        )
        .get(
          id,
          new Date().toISOString(),
          'which shape?',
          'use the existing shape',
          new Date().toISOString(),
          new Date().toISOString(),
        ) as { number: number }
    ).number
    const dispatch: typeof detach = async () => {
      throw new Error('fixture retry dispatch failed')
    }

    await expect(retryRun(id, { flags }, { ...helpers, dispatch })).rejects.toThrow(
      'fixture retry dispatch failed',
    )
    expect(
      db()
        .query(
          'SELECT run_record_id,mode,outcome,error FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE number=?)',
        )
        .get(questionId),
    ).toEqual({
      run_record_id: null,
      mode: 'retry',
      outcome: 'failed',
      error: 'fixture retry dispatch failed',
    })
  })

  test('retry provisions a released reader from its recorded base', async () => {
    const id = failed()
    const registeredPath = process.cwd()
    upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: registeredPath })
    const baseCommit = gitContext(registeredPath, 'rev-parse', '--verify', 'HEAD')!
    const released = join(dir, `released-reader-${id}`)
    db()
      .query('UPDATE run SET cwd=?,worktree=?,base_commit=? WHERE record_id=?')
      .run(released, released, baseCommit, id)
    const dispatchedId = addRun({
      agent: 'grok',
      job: 'file-question',
      status: 'ok',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const dispatched: Parameters<typeof detach>[2][] = []
    const dispatch: typeof detach = async (_job, _prompt, spec) => {
      dispatched.push(spec)
      return dispatchedId
    }

    await retryRun(id, { flags }, { ...helpers, dispatch })

    expect(dispatched[0]?.cwd).toBe(registeredPath)
    expect(dispatched[0]?.resume).toMatchObject({
      kind: 'retry-root',
      parent: id,
      worktree: null,
      readOnlyBase: baseCommit,
    })
  })
})
