import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writeMachineNames } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  type AnswerIdentifierFacts,
  answerIdentifierDecision,
  parseAnswerIdentifier,
  resolveAnswerTarget,
} from './run-answer-identifier.ts'

async function resolveAnswerIdentifier(input: string | number, callerSessionId: string | null) {
  const target = await resolveAnswerTarget(db(), input, callerSessionId)
  if (target.kind !== 'target') throw new Error('expected a run target')
  return target.runRecordId
}

const run = (overrides: Partial<NonNullable<AnswerIdentifierFacts['run']>> = {}) => ({
  recordId: 'asking-run',
  rootRecordId: 'asking-run',
  status: 'asking',
  ownedByCaller: true,
  openQuestionNumbers: [14],
  ...overrides,
})

const question = (overrides: Partial<NonNullable<AnswerIdentifierFacts['question']>> = {}) => ({
  kind: 'run-question' as const,
  rootRecordId: 'question-root',
  open: true,
  state: 'open' as const,
  openQuestionNumbers: [12],
  ...overrides,
})

describe('answer identifier parse', () => {
  test('preserves qualifiers for identity resolution', () => {
    const names = { shortName: 'mine', formerShortNames: ['old-mine'] }
    expect(parseAnswerIdentifier('beta#q42', names)).toEqual({
      kind: 'question-number',
      number: 42,
      qualifier: { kind: 'project', value: 'beta' },
    })
    expect(parseAnswerIdentifier('mine/r42', names)).toEqual({
      kind: 'run-number',
      number: 42,
      qualifier: { kind: 'machine', value: 'mine' },
    })
  })
  test('refuses a machine qualifier on a question with the project-qualified remedy', () => {
    expect(() => parseAnswerIdentifier('mine/q42')).toThrow(
      'question references cannot use a machine qualifier; pass a <project>#q<number> reference',
    )
  })
  test('owns q-prefix grammar and accepts the run identifier forms', () => {
    const recordId = newRecordId()
    expect(parseAnswerIdentifier('q42')).toEqual({ kind: 'question-number', number: 42 })
    expect(parseAnswerIdentifier('42')).toEqual({ kind: 'run-number', number: 42 })
    expect(parseAnswerIdentifier(recordId.toUpperCase())).toEqual({
      kind: 'record-id',
      recordId,
    })
    expect(() => parseAnswerIdentifier('q0')).toThrow('invalid answer identifier')
  })
})

describe('answer identifier decision', () => {
  test('refuses an answered or closed question and names the chain current wait', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'question-number', number: 12 },
        run: null,
        question: question({ open: false, state: 'ruled', openQuestionNumbers: [14] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'q12 is already ruled on; run question-root is waiting on q14',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'question-number', number: 12 },
        run: null,
        question: question({ open: false, state: 'closed', openQuestionNumbers: [] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'q12 is closed; run question-root has no open questions',
    })
  })

  test('treats any different-chain question collision as ambiguous', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run(),
        question: question({ open: false, state: 'ruled', openQuestionNumbers: [] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason:
        'bare identifier 12 is ambiguous between run:12 (asking-run) and q12; pass the run UUID or q12',
    })
  })

  test('does not call a same-chain collision ambiguous', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run(),
        question: question({ rootRecordId: 'asking-run', open: false, state: 'ruled' }),
      }),
    ).toEqual({ kind: 'target', runRecordId: 'asking-run' })
  })

  test('distinguishes no open question, foreign ownership, and non-asking status', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ status: 'ok', openQuestionNumbers: [] }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'run 12 has no open question (status: ok); to answer question q12, pass q12',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ ownedByCaller: false, openQuestionNumbers: [14, 15] }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason:
        'run 12 has open questions but they are not owned by the current session; answer them explicitly with q14, q15',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ status: 'running' }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'run 12 is not asking (status: running); answer it explicitly with q14',
    })
  })
})

function addQuestion(runRecordId: string, number: number, recordId = newRecordId()): string {
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,?,?,'2026-10-14','Which?')`,
    )
    .run(recordId, number, runRecordId)
  return recordId
}

test('question number and UUID resolve an open question asked by a real turn to its root', async () => {
  const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  const turn = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  const questionId = addQuestion(turn, 73)

  expect(await resolveAnswerIdentifier('q73', null)).toBe(root)
  expect(await resolveAnswerIdentifier(questionId, null)).toBe(root)
})

test('a qualified question resolves in that project while an unqualified label stays local', async () => {
  const suffix = newRecordId().slice(-8)
  const alphaName = `answer-alpha-${suffix}`
  const betaName = `answer-beta-${suffix}`
  const alpha = newRecordId()
  const beta = newRecordId()
  const session = `answer-session-${suffix}`
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(alpha, alphaName, `/tmp/${alphaName}`, '{}')
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(beta, betaName, `/tmp/${betaName}`, '{}')
  db()
    .query(
      `INSERT INTO presence
         (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES (?,'codex','architect','machine',?,?,?,'2026-11-17','2026-11-17')`,
    )
    .run(session, alphaName, alpha, `/tmp/${alphaName}`)
  const alphaRun = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    projectRecordId: alpha,
  })
  const betaRun = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    projectRecordId: beta,
  })
  const alphaNumber = 880_001
  const betaNumber = 880_002
  addQuestion(alphaRun, alphaNumber)
  addQuestion(betaRun, betaNumber)

  expect(await resolveAnswerIdentifier(`q${alphaNumber}`, session)).toBe(alphaRun)
  expect(await resolveAnswerIdentifier(`${betaName}#q${betaNumber}`, session)).toBe(betaRun)
})

test('an answered question target refuses instead of selecting another open question', async () => {
  const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  const answeredId = addQuestion(root, 81)
  addQuestion(root, 82)
  db()
    .query("UPDATE question SET answered_at='2026-10-15',answer='yes' WHERE record_id=?")
    .run(answeredId)

  await expect(resolveAnswerIdentifier('q81', null)).rejects.toThrow(
    `q81 is already ruled on; run ${root} is waiting on q82`,
  )
  await expect(resolveAnswerIdentifier(answeredId, null)).rejects.toThrow(
    `${answeredId} is already ruled on; run ${root} is waiting on q82`,
  )
})

test('bare-number resolution uses real run, question, ownership, and chain facts', async () => {
  const session = 'answer-session'
  const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const other = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const runNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(asking)!.number
  const collidingQuestion = addQuestion(other, runNumber)
  db()
    .query("UPDATE question SET answered_at='2026-10-15',answer='done' WHERE record_id=?")
    .run(collidingQuestion)
  addQuestion(asking, runNumber + 1000)

  await expect(resolveAnswerIdentifier(runNumber, session)).rejects.toThrow(
    `bare identifier ${runNumber} is ambiguous between run:${runNumber} (${asking}) and q${runNumber}`,
  )
  expect(await resolveAnswerIdentifier(asking, session)).toBe(asking)
})

test('machine-qualified run numbers resolve without a question-number collision check', async () => {
  const machineName = 'answer-machine'
  writeMachineNames({ shortName: machineName, displayName: 'Answer Machine' })
  const session = 'machine-qualified-answer-session'
  const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const runNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(asking)!.number
  addQuestion(asking, runNumber + 1000)

  expect(await resolveAnswerIdentifier(`${machineName}/${runNumber}`, session)).toBe(asking)
  expect(await resolveAnswerIdentifier(`${machineName}/r${runNumber}`, session)).toBe(asking)
})

test('a bare number with no run keeps the explicit question hint', async () => {
  const owner = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  const number = 900_001
  addQuestion(owner, number)

  await expect(resolveAnswerIdentifier(number, null)).rejects.toThrow(
    `run ${number} does not exist; to answer question q${number}, pass q${number}`,
  )
})

function addCursorQuestion(input: {
  state: 'running' | 'awaiting-ruling'
  closed?: boolean
  answered?: boolean
}) {
  const suffix = newRecordId().slice(-8)
  const project = `cursor-answer-${suffix}`
  const projectId = newRecordId()
  const cursorId = newRecordId()
  const questionId = newRecordId()
  const questionNumber = 890_000 + Number.parseInt(suffix.slice(0, 4), 16)
  const caller = `cursor-answer-session-${suffix}`
  db().exec('PRAGMA foreign_keys=OFF')
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(projectId, project, `/tmp/${project}`, '{}')
  db()
    .query(
      `INSERT INTO presence
         (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES (?,'codex','architect','machine',?,?,?,'2026-11-17','2026-11-17')`,
    )
    .run(caller, project, projectId, `/tmp/${project}`)
  db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at)
       VALUES (?,9876,?,?,'flow','default','DEV-2394','',?, ?,?,'{}',2,'review',?,'[]',NULL,4,'2026-11-17','2026-11-17')`,
    )
    .run(cursorId, project, projectId, caller, newRecordId(), newRecordId(), input.state)
  db()
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question,asked_via,
         answered_at,answer,closed_at,close_reason)
       VALUES (?,?,?,'2026-11-17','Proceed?','workflow',?,?,?,?)`,
    )
    .run(
      questionId,
      questionNumber,
      cursorId,
      input.answered ? '2026-11-17' : null,
      input.answered ? 'yes' : null,
      input.closed ? '2026-11-17' : null,
      input.closed ? 'advanced-without-ruling' : null,
    )
  db().exec('PRAGMA foreign_keys=ON')
  return { caller, cursorId, project, questionId, questionNumber }
}

test('an open cursor question names the workflow rule remedy with its cursor and project', async () => {
  const fixture = addCursorQuestion({ state: 'awaiting-ruling' })
  await expect(
    resolveAnswerTarget(db(), `q${fixture.questionNumber}`, fixture.caller),
  ).rejects.toThrow(`use ${PLATFORM_SLUG} workflow rule --cursor 9876 --project ${fixture.project}`)
})

test('a closed unanswered cursor question resolves by bare q-number to the question target', async () => {
  const fixture = addCursorQuestion({ state: 'running', closed: true })
  expect(await resolveAnswerTarget(db(), `q${fixture.questionNumber}`, fixture.caller)).toEqual({
    kind: 'workflow-question',
    questionRecordId: fixture.questionId,
    cursorRecordId: fixture.cursorId,
  })
})

test('an answered cursor question refuses as already ruled on without naming a null run', async () => {
  const fixture = addCursorQuestion({ state: 'running', answered: true })
  const message = await resolveAnswerTarget(
    db(),
    `q${fixture.questionNumber}`,
    fixture.caller,
  ).then(
    () => 'resolved unexpectedly',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  expect(message).toBe(`q${fixture.questionNumber} is already ruled on`)
  expect(message).not.toContain('null')
})

test('a cursor question whose cursor is absent refuses without rendering a null cursor remedy', () => {
  const cursorRecordId = newRecordId()
  const decision = answerIdentifierDecision({
    identifier: { kind: 'question-number', number: 881_001 },
    run: null,
    question: {
      kind: 'workflow-question',
      recordId: newRecordId(),
      cursorRecordId,
      cursorNumber: null,
      project: null,
      open: true,
      state: 'open',
    },
  })
  expect(decision).toEqual({
    kind: 'refuse',
    reason: `q881001's workflow cursor ${cursorRecordId} is not on this machine; rule it from the machine that holds that cursor`,
  })
  expect(decision.kind === 'refuse' ? decision.reason : '').not.toContain('--cursor null')
})
