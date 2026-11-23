import { expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { createAskMcpServer } from './ask.ts'

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: 'text'; text: string }[])[0]!.text
}

test('malformed MCP text reaches each handler as an ordinary refusal without writing', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const server = createAskMcpServer(run, '')
  const client = new Client({ name: `${WORKER_MCP_SERVER_NAME}-test`, version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    const askTool = tools.tools.find((tool) => tool.name === 'ask_orchestrator')
    expect(askTool?.inputSchema.properties?.question).toMatchObject({ type: 'string' })
    const question = await client.callTool({
      name: 'ask_orchestrator',
      arguments: {
        question: {
          kind: 'choice',
          question: 'Which threshold?',
          options: ['100', '500'],
          recommendation: '500',
          why: 'The implementation depends on the threshold.',
        },
      },
    })
    expect(question.isError).toBeUndefined()
    expect(resultText(question)).toContain('question was an object')
    expect(resultText(question)).toContain('Call ask_orchestrator again')
    expect(resultText(question)).toContain('Do not decide the matter yourself')
    const note = await client.callTool({ name: 'note', arguments: { text: { nested: true } } })
    expect(note.isError).toBeUndefined()
    expect(resultText(note)).toContain('text was an object')
    const message = await client.callTool({
      name: 'message_orchestrator',
      arguments: { body: { nested: true } },
    })
    expect(message.isError).toBeUndefined()
    expect(resultText(message)).toContain('body was an object')
    expect(
      db()
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM question WHERE run_record_id = ?',
        )
        .get(run)?.n,
    ).toBe(0)
  } finally {
    await client.close()
    await server.close()
  }
})
