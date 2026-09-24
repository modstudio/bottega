import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { ask, createAskMcpServer } from './ask.ts'

async function askClient(runId: number, token = '', timeoutMs?: number) {
  const server = createAskMcpServer(runId, token, timeoutMs)
  const client = new Client({ name: 'orch-ask-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: 'text'; text: string }[])[0]!.text
}

describe('the live ask channel always answers', () => {
  test('a live question is answerable through the command, not only in SQL', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(live, new Date().toISOString(), 'which table?')
    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as {
        status: string
        parent_run_id: number | null
      }
      const open = db()
        .query(
          `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
        )
        .get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }
    expect(answerable(live)).toBe(true)
    expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })
  test('a question asked on turn two is answerable from the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')
    const open = db()
      .query(
        `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      )
      .all(root, root) as { id: number }[]
    expect(open.length).toBe(1)
  })
  test('an unanswered question survives the timeout', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db()
      .query('SELECT COUNT(*) AS n FROM question WHERE run_id = ? AND answered_at IS NULL')
      .get(run) as { n: number }
    expect(open.n).toBe(1)
  })

  test('missing required text instructs the worker without recording or returning an error', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const { client, close } = await askClient(run)
    try {
      const tools = await client.listTools()
      const askTool = tools.tools.find((tool) => tool.name === 'ask_orchestrator')
      const messageTool = tools.tools.find((tool) => tool.name === 'message_orchestrator')
      expect(askTool?.inputSchema.required).toContain('question')
      expect(messageTool?.inputSchema.required).toContain('body')

      const question = await client.callTool({ name: 'ask_orchestrator', arguments: {} })
      expect(question.isError).toBeUndefined()
      expect(resultText(question)).toContain('Call ask_orchestrator again')
      expect(resultText(question)).toContain('Do not decide the matter yourself')

      const message = await client.callTool({ name: 'message_orchestrator', arguments: {} })
      expect(message.isError).toBeUndefined()
      expect(resultText(message)).toContain('Call message_orchestrator again')
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM question WHERE run_id = ?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(0)
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM run_message WHERE run_id = ?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(0)
    } finally {
      await close()
    }
  })

  test('ask returns ordinary replies when it times out or cannot record', async () => {
    const timedOutRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const timeoutConnection = await askClient(timedOutRun, '', 0)
    try {
      const result = await timeoutConnection.client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toContain('No ruling arrived within the time limit')
    } finally {
      await timeoutConnection.close()
    }

    const failedRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().exec(
      "CREATE TEMP TRIGGER fail_question BEFORE INSERT ON question BEGIN SELECT RAISE(FAIL, 'fixture recording failure'); END",
    )
    const failureConnection = await askClient(failedRun)
    try {
      const result = await failureConnection.client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toContain('fixture recording failure')
      expect(resultText(result)).toContain('Do not decide it yourself')
    } finally {
      await failureConnection.close()
      db().exec('DROP TRIGGER fail_question')
    }
  })

  test('every tool gives an unauthorized caller blocked-status guidance', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET run_token = ? WHERE id = ?').run('right-token', run)
    const { client, close } = await askClient(run, 'wrong-token')
    try {
      const question = await client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      const message = await client.callTool({
        name: 'message_orchestrator',
        arguments: { body: 'Progress' },
      })
      const check = await client.callTool({
        name: 'check_orchestrator_messages',
        arguments: {},
      })

      expect(question.isError).toBeUndefined()
      expect(message.isError).toBe(true)
      expect(check.isError).toBe(true)
      for (const result of [question, message, check]) {
        expect(resultText(result)).toContain('Return status "blocked" with your question')
      }
    } finally {
      await close()
    }
  })

  test('message and check expose operation failures as tool errors', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const { client, close } = await askClient(run)
    try {
      const message = await client.callTool({
        name: 'message_orchestrator',
        arguments: { body: 'Progress' },
      })
      const check = await client.callTool({
        name: 'check_orchestrator_messages',
        arguments: {},
      })
      expect(message.isError).toBe(true)
      expect(resultText(message)).toContain('is asking, not running')
      expect(check.isError).toBe(true)
      expect(resultText(check)).toContain('is asking, not running')
    } finally {
      await close()
    }
  })
})
