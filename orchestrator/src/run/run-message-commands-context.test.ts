import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags as flags,
  insertRun as insert,
  newQuestionSql,
} from '../../test/fixtures/run-answer.ts'
import { installRunAnswerEnvironment } from '../../test/fixtures/run-answer-environment.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import { answerCommand, retryCommand } from './run-message-commands.ts'

let restoreEnvironment: () => void
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => restoreEnvironment())

const contextPorts = (calls: string[]): ContextMomentPorts =>
  ({
    revision: async () => undefined,
    set: async (input) => {
      calls.push(`set ${input.kind} ${input.id} on ${input.task}`)
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
  }) as ContextMomentPorts

test('answering a continuation turn question writes its root task position', async () => {
  const root = insert('ok')
  db()
    .query("UPDATE run SET launch_key='DEV-2225',cursor_record_id=? WHERE record_id=?")
    .run(newRecordId(), root)
  const turn = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    parent: root,
    turn: 2,
    session: 'orch-test-session',
  })
  const question = db()
    .query<{ number: number }, [string, string, string]>(`${newQuestionSql()} RETURNING number`)
    .get(turn, new Date().toISOString(), 'Which shape?')!
  const calls: string[] = []

  await answerCommand(
    turn,
    ['Keep the approved shape.'],
    true,
    false,
    flags,
    { printRunId: () => {} },
    undefined,
    { ports: contextPorts(calls), output: { log: () => {}, error: () => {} } },
  )

  expect(calls).toEqual([`set position position-q${question.number} on DEV-2225`])
})

test('partial record-only answer writes only the selected question position', async () => {
  const root = insert('asking')
  db()
    .query("UPDATE run SET launch_key='DEV-2225',cursor_record_id=? WHERE record_id=?")
    .run(newRecordId(), root)
  const addQuestion = (question: string) =>
    db()
      .query<{ record_id: string; number: number }, [string, string, string]>(
        `${newQuestionSql()} RETURNING record_id,number`,
      )
      .get(root, new Date().toISOString(), question)!
  const first = addQuestion('First question?')
  const selected = addQuestion('Selected question?')
  const calls: string[] = []

  await answerCommand(
    root,
    [`--q${selected.record_id}`, 'Use the selected answer.'],
    true,
    false,
    flags,
    { printRunId: () => {} },
    undefined,
    { ports: contextPorts(calls), output: { log: () => {}, error: () => {} } },
  )

  expect(calls).toEqual([`set position position-q${selected.number} on DEV-2225`])
  expect(
    db()
      .query<{ record_id: string; answered_at: string | null }, [string]>(
        'SELECT record_id,answered_at FROM question WHERE run_record_id=? ORDER BY number',
      )
      .all(root),
  ).toEqual([
    { record_id: first.record_id, answered_at: null },
    { record_id: selected.record_id, answered_at: expect.any(String) },
  ])
})

test('an operator answer writes its root task ruling', async () => {
  const root = insert('asking')
  db()
    .query("UPDATE run SET launch_key='DEV-2225',cursor_record_id=? WHERE record_id=?")
    .run(newRecordId(), root)
  const question = db()
    .query<{ record_id: string; number: number }, [string, string, string]>(
      `${newQuestionSql()} RETURNING record_id,number`,
    )
    .get(root, new Date().toISOString(), 'Which shape?')!
  const calls: string[] = []

  await answerCommand(
    root,
    [`--q${question.number}`, 'Use the approved shape.', '--from-operator'],
    true,
    false,
    flags,
    { printRunId: () => {} },
    undefined,
    { ports: contextPorts(calls), output: { log: () => {}, error: () => {} } },
  )

  expect(calls).toEqual([`set ruling ruling-q${question.number} on DEV-2225`])
})

test('a context port failure leaves the answer recorded and reports without throwing', async () => {
  const root = insert('asking')
  db()
    .query("UPDATE run SET launch_key='DEV-2225',cursor_record_id=? WHERE record_id=?")
    .run(newRecordId(), root)
  const question = db()
    .query<{ record_id: string; number: number }, [string, string, string]>(
      `${newQuestionSql()} RETURNING record_id,number`,
    )
    .get(root, new Date().toISOString(), 'Which shape?')!
  const lines: string[] = []
  const throwing = {
    revision: async () => undefined,
    set: async () => {
      throw new Error('context unavailable')
    },
  } as ContextMomentPorts

  await answerCommand(
    root,
    [`--q${question.number}`, 'Keep the approved shape.'],
    true,
    false,
    flags,
    { printRunId: () => {} },
    undefined,
    { ports: throwing, output: { log: (line) => lines.push(line), error: () => {} } },
  )

  expect(
    db()
      .query<{ answer: string }, [string]>('SELECT answer FROM question WHERE record_id=?')
      .get(question.record_id),
  ).toEqual({ answer: 'Keep the approved shape.' })
  expect(lines).toContainEqual(
    expect.stringContaining(
      'context: could not write position on DEV-2225: context unavailable; retry:',
    ),
  )
})

test('answer admission refusal leaves the question open and does not answer the run', async () => {
  const root = insert('asking')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
  const question = db()
    .query<{ record_id: string }, [string, string, string]>(
      `${newQuestionSql()} RETURNING record_id`,
    )
    .get(root, new Date().toISOString(), 'Which shape?')!
  let answered = false

  await expect(
    answerCommand(
      root,
      ['Keep the approved shape.'],
      true,
      false,
      flags,
      { printRunId: () => {} },
      undefined,
      undefined,
      {
        admitKeyedTurn: async (input) => {
          expect(input).toEqual({ runId: root, turn: 'answer', overridePersonName: null })
          throw new Error('refusing unbound keyed answer')
        },
        answerRun: async () => {
          answered = true
          throw new Error('answerRun must not run')
        },
      },
    ),
  ).rejects.toThrow('refusing unbound keyed answer')

  expect(answered).toBe(false)
  expect(
    db()
      .query<{ answer: string | null }, [string]>('SELECT answer FROM question WHERE record_id=?')
      .get(question.record_id),
  ).toEqual({ answer: null })
})

test('retry admission refusal leaves the question open and does not retry the run', async () => {
  const root = insert('asking')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
  const question = db()
    .query<{ record_id: string }, [string, string, string]>(
      `${newQuestionSql()} RETURNING record_id`,
    )
    .get(root, new Date().toISOString(), 'Which shape?')!
  let retried = false

  await expect(
    retryCommand(
      root,
      { flags },
      { printRunId: () => {} },
      { fromOperator: false },
      {
        admitKeyedTurn: async (input) => {
          expect(input).toEqual({
            runId: root,
            turn: 'retry',
            fromOperator: false,
            overridePersonName: null,
          })
          throw new Error('refusing unbound keyed retry')
        },
        retryRun: async () => {
          retried = true
          throw new Error('retryRun must not run')
        },
      },
    ),
  ).rejects.toThrow('refusing unbound keyed retry')

  expect(retried).toBe(false)
  expect(
    db()
      .query<{ answer: string | null }, [string]>('SELECT answer FROM question WHERE record_id=?')
      .get(question.record_id),
  ).toEqual({ answer: null })
})

test('retry records its admission override on the new retry root', async () => {
  const root = insert('failed')
  const retryRoot = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const warnings: Array<{ runId: string; warning: string | null }> = []

  await retryCommand(
    root,
    { flags },
    { printRunId: () => {} },
    { overrideReason: 'Operator approved.', fromOperator: true },
    {
      admitKeyedTurn: async () => ({ warning: 'operator override warning', binding: undefined }),
      retryRun: async () => retryRoot,
      recordKeyedTurnOverride: (runId, warning) => warnings.push({ runId, warning }),
    },
  )

  expect(warnings).toEqual([{ runId: retryRoot, warning: 'operator override warning' }])
})
