import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { createDocsMcpServer } from './mcp.ts'

const SESSION = 'mcp-operator-tools-test'
let priorSession: string | undefined
let priorRunId: string | undefined

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  priorRunId = process.env.ORCH_RUN_ID
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
  delete process.env.ORCH_RUN_ID
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
  else process.env.ORCH_RUN_ID = priorRunId
})

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createDocsMcpServer()
  const client = new Client({ name: 'orch-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

function addQuestion(runId: number, question: string, waiting = false): number {
  const at = new Date().toISOString()
  return (
    db()
      .query(
        `INSERT INTO question (run_id,asked_at,question,awaiting_operator_at)
         VALUES (?,?,?,?) RETURNING id`,
      )
      .get(runId, at, question, waiting ? at : null) as { id: number }
  ).id
}

describe('operator MCP tools', () => {
  test('list_open_questions returns session questions and operator-waiting items', async () => {
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      session: SESSION,
      repo: PLATFORM_SLUG,
    })
    const questionId = addQuestion(runId, 'Which shape?', true)

    const result = await withClient((client) =>
      client.callTool({ name: 'list_open_questions', arguments: {} }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      questions: [{ question_id: questionId, answer_id: runId, can_answer: true }],
      waiting_on_operator: [{ kind: 'question', id: questionId, run_id: runId }],
    })
  })

  test('list_open_questions excludes a same-project foreign session and accepts no-project waiting items', async () => {
    const ownRun = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      session: SESSION,
    })
    db().query('UPDATE run SET repo=NULL WHERE id=?').run(ownRun)
    const ownQuestion = addQuestion(ownRun, 'Owned without a project?', true)
    const foreignRun = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      session: 'foreign-session',
      repo: PLATFORM_SLUG,
    })
    const foreignQuestion = addQuestion(foreignRun, 'Foreign question?')

    const result = await withClient((client) =>
      client.callTool({ name: 'list_open_questions', arguments: {} }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      questions: [{ question_id: ownQuestion }],
      waiting_on_operator: [{ id: ownQuestion, project: null }],
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      `"question_id":${foreignQuestion}`,
    )
  })

  test('answer_questions delivers through the in-process client and records the MCP channel', async () => {
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'running',
      session: SESSION,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, runId)
    const questionId = addQuestion(runId, 'Which shape?')

    const result = await withClient((client) =>
      client.callTool({
        name: 'answer_questions',
        arguments: {
          run_id: runId,
          rulings: [{ question_id: questionId, ruling: 'Use the existing shape.' }],
        },
      }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      outcome: 'delivered-live',
      run_id: runId,
      resumed_as: null,
    })
    expect(
      db().query('SELECT answer,answer_channel FROM question WHERE id=?').get(questionId),
    ).toEqual({ answer: 'Use the existing shape.', answer_channel: 'mcp' })
  })

  test('answer_questions stores flag-shaped rulings verbatim and attributes only explicit operators', async () => {
    const literals = [
      '--file=/etc/hosts',
      '--file',
      '--from-operator',
      '--record-only',
      '--channel',
      '--channel=ui',
      '--q9',
    ]
    await withClient(async (client) => {
      for (const [index, ruling] of literals.entries()) {
        const runId = addRun({
          agent: 'codex',
          job: 'file-question',
          status: 'running',
          session: SESSION,
        })
        db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, runId)
        const questionId = addQuestion(runId, `Literal ${index}?`)
        const fromOperator = index === literals.length - 1

        const result = await client.callTool({
          name: 'answer_questions',
          arguments: {
            run_id: runId,
            rulings: [{ question_id: questionId, ruling }],
            from_operator: fromOperator,
          },
        })

        expect(result.isError).not.toBe(true)
        expect(
          db()
            .query('SELECT answer,answered_by,answer_channel FROM question WHERE id=?')
            .get(questionId),
        ).toEqual({
          answer: ruling,
          answered_by: fromOperator ? `operator via ${SESSION}` : SESSION,
          answer_channel: 'mcp',
        })
      }
    })
  })

  test('answer_questions returns the all-open-questions refusal as a tool error', async () => {
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      session: SESSION,
    })
    const first = addQuestion(runId, 'First question?')
    addQuestion(runId, 'Second question?')

    const result = await withClient((client) =>
      client.callTool({
        name: 'answer_questions',
        arguments: {
          run_id: runId,
          rulings: [{ question_id: first, ruling: 'Only one ruling.' }],
          record_only: true,
        },
      }),
    )

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain(
      '2 question(s) open but 1 ruling(s) given',
    )
    expect(
      db().query('SELECT COUNT(*) count FROM question WHERE answered_at IS NOT NULL').get(),
    ).toEqual({ count: 0 })
  })

  test('overturn_ruling returns the full updated ruling status', async () => {
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      session: SESSION,
    })
    const questionId = addQuestion(runId, 'Which shape?')
    const answeredAt = new Date().toISOString()
    db()
      .query(
        `UPDATE question SET answer=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?
         WHERE id=?`,
      )
      .run('Original ruling.', answeredAt, SESSION, 'agent', 'cli', questionId)

    const result = await withClient((client) =>
      client.callTool({
        name: 'overturn_ruling',
        arguments: {
          question_id: questionId,
          because: 'The premise changed.',
          replacement: 'Use the replacement.',
        },
      }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      question_id: questionId,
      ruling_status: 'overturned',
      overturned_at: expect.any(String),
      overturned_by: SESSION,
      overturn_reason: 'The premise changed.',
      replacement: 'Use the replacement.',
    })
  })

  test('file_ruling returns the recorded filing through the same service', async () => {
    const { createMemoryRecordApiClient, installRecordApiClient } = await import(
      '../../test/fixtures/record-api.ts'
    )
    const { upsertProject } = await import('../project/projects.ts')
    installRecordApiClient(createMemoryRecordApiClient())
    upsertProject({ name: 'file-ruling-project', path: process.cwd() })
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'ok',
      session: SESSION,
      repo: 'file-ruling-project',
    })
    const questionId = addQuestion(runId, 'Which shape?')
    db()
      .query(
        `UPDATE question SET answer=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?
         WHERE id=?`,
      )
      .run('Keep it.', new Date().toISOString(), SESSION, 'operator', 'cli', questionId)

    const result = await withClient((client) =>
      client.callTool({
        name: 'file_ruling',
        arguments: { question_id: questionId, as: 'doc' },
      }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      question_id: questionId,
      filed_as: 'doc',
      filed_ref: expect.stringMatching(/@/),
      filed_at: expect.any(String),
    })
    expect(db().query('SELECT filed_as FROM question WHERE id=?').get(questionId)).toEqual({
      filed_as: 'doc',
    })

    const workerRunId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'ok',
      session: SESSION,
      repo: 'file-ruling-project',
    })
    const workerQuestionId = addQuestion(workerRunId, 'Which worker shape?')
    db()
      .query(
        `UPDATE question SET answer=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?
         WHERE id=?`,
      )
      .run('Keep it.', new Date().toISOString(), SESSION, 'operator', 'cli', workerQuestionId)
    process.env.ORCH_RUN_ID = 'mcp-worker'
    const refused = await withClient((client) =>
      client.callTool({
        name: 'file_ruling',
        arguments: { question_id: workerQuestionId, as: 'doc' },
      }),
    )
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('refusing document store write from an orch worker run'),
      }),
    ])
  })
})
