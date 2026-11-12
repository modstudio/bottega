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
import { answerCommand } from './run-message-commands.ts'

let restoreEnvironment: () => void
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => restoreEnvironment())

const contextPorts = (calls: string[]): ContextMomentPorts =>
  ({
    set: async (input) => {
      calls.push(`set ${input.kind} ${input.id}`)
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
    drop: async (input) => {
      calls.push(`drop ${input.id}`)
      return { holder: `task:${input.task}`, task: input.task ?? null, id: input.id, removed: true }
    },
  }) as ContextMomentPorts

test('answering a continuation turn question writes its root task position', async () => {
  const root = insert('ok')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
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

  expect(calls).toEqual([
    `set position position-q${question.number}`,
    `drop open-q${question.number}`,
  ])
})

test('partial record-only answer writes only the selected question position', async () => {
  const root = insert('asking')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
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

  expect(calls).toEqual([
    `set position position-q${selected.number}`,
    `drop open-q${selected.number}`,
  ])
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

test('a context port failure leaves the answer recorded and reports without throwing', async () => {
  const root = insert('asking')
  db().query("UPDATE run SET launch_key='DEV-2225' WHERE record_id=?").run(root)
  const question = db()
    .query<{ record_id: string; number: number }, [string, string, string]>(
      `${newQuestionSql()} RETURNING record_id,number`,
    )
    .get(root, new Date().toISOString(), 'Which shape?')!
  const lines: string[] = []
  const throwing = {
    set: async () => {
      throw new Error('context unavailable')
    },
    drop: async () => {
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
