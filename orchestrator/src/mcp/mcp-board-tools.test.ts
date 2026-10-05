import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { BOARD_TITLE_MAX_CHARS } from '../board/board-policy.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { registerBoardTools } from './mcp-board-tools.ts'

async function withBoardClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: 'orch-board-test', version: '1.0.0' })
  registerBoardTools(server)
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

test('board_status MCP tool refuses worker callers', async () => {
  const posted = postNotice(
    { audience: 'operator', title: 'MCP status guard', body: 'Workers cannot inspect status.' },
    {},
  )
  process.env.ORCH_RUN_ID = 'mcp-board-worker'
  try {
    const result = await withBoardClient((client) =>
      client.callTool({ name: 'board_status', arguments: { id: String(posted.id) } }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('workers cannot use') }),
    ])
  } finally {
    delete process.env.ORCH_RUN_ID
  }
})

test('board_post MCP schema mirrors the title size ceiling before service storage', async () => {
  const result = await withBoardClient((client) =>
    client.callTool({
      name: 'board_post',
      arguments: {
        audience: 'operator',
        title: 'z'.repeat(BOARD_TITLE_MAX_CHARS + 1),
        body: 'safe body',
      },
    }),
  )
  expect(result.isError).toBe(true)
  expect(
    (db().query('SELECT COUNT(*) count FROM board_message').get() as { count: number }).count,
  ).toBe(0)
})

test('board_read MCP result is the delivery envelope with one normalized notice shape', async () => {
  const posted = postNotice(
    { audience: 'operator', title: 'MCP read shape', body: 'Read through the envelope.' },
    {},
  )
  const identityKeys = [
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'ORCH_RUN_ID',
    'ORCH_DEPTH',
  ] as const
  const identity = Object.fromEntries(identityKeys.map((key) => [key, process.env[key]]))
  for (const key of identityKeys) delete process.env[key]
  const result = await withBoardClient((client) =>
    client.callTool({ name: 'board_read', arguments: {} }),
  ).finally(() => {
    for (const key of identityKeys) {
      const value = identity[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const parsed = JSON.parse((result.content as { type: 'text'; text: string }[])[0]!.text)
  expect(parsed).toEqual({
    notices: [
      {
        id: String(posted.id),
        text: expect.stringContaining(`BOARD NOTICE ${posted.id}`),
        ackRequired: false,
        createdAt: expect.any(String),
      },
    ],
    warning: null,
  })
})
