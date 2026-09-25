import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { createDocsMcpServer } from './mcp.ts'

const SESSION = 'mcp-operator-tools-test'
let priorSession: string | undefined

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
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
})
