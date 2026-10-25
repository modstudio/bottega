import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { BOARD_TITLE_MAX_CHARS } from '../board/board-policy.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { registerBoardTools } from './mcp-board-tools.ts'

let identityKeys: string[] = []
let identityEnvironment: Record<string, string | undefined> = {}

beforeEach(() => {
  identityKeys = [
    ...Object.keys(process.env).filter((key) => /(?:SESSION_ID|THREAD_ID)$/.test(key)),
    'CLAUDE_CODE_SESSION_ID',
    'BOTTEGA_RUN_ID',
    'BOTTEGA_DEPTH',
  ]
  identityEnvironment = Object.fromEntries(identityKeys.map((key) => [key, process.env[key]]))
  for (const key of identityKeys) delete process.env[key]
})

afterEach(() => {
  for (const key of identityKeys) {
    const value = identityEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

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
  process.env.BOTTEGA_RUN_ID = 'mcp-board-worker'
  try {
    const result = await withBoardClient((client) =>
      client.callTool({ name: 'board_status', arguments: { id: String(posted.recordId) } }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('workers cannot use') }),
    ])
  } finally {
    delete process.env.BOTTEGA_RUN_ID
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

test('board_reply MCP stores and applies its audience option through the shared service', async () => {
  const root = postNotice(
    { audience: 'operator', title: 'MCP reply audience', body: 'Address the chosen reader.' },
    {},
  )
  const result = await withBoardClient((client) =>
    client.callTool({
      name: 'board_reply',
      arguments: {
        root_id: String(root.recordId),
        body: 'Directed reply',
        audience: 'session:chosen-reader',
      },
    }),
  )
  expect(result.isError).not.toBe(true)
  const reply = db()
    .query(
      `SELECT record_id,audience FROM board_message
       WHERE thread_root_record_id=? AND kind='reply'`,
    )
    .get(root.recordId) as { record_id: string; audience: string }
  expect(reply.audience).toBe('session:chosen-reader')
  expect(
    db()
      .query('SELECT reader_session FROM board_receipt WHERE message_record_id=?')
      .all(reply.record_id),
  ).toEqual([{ reader_session: 'chosen-reader' }])
})

test('board_read MCP result is the delivery envelope with one normalized notice shape', async () => {
  const posted = postNotice(
    { audience: 'operator', title: 'MCP read shape', body: 'Read through the envelope.' },
    {},
  )
  const result = await withBoardClient((client) =>
    client.callTool({ name: 'board_read', arguments: {} }),
  )
  const parsed = JSON.parse((result.content as { type: 'text'; text: string }[])[0]!.text)
  expect(parsed).toEqual({
    notices: [
      {
        id: String(posted.number),
        text: expect.stringContaining(`BOARD NOTICE ${posted.number}`),
        oneLine: `Board message ${posted.number}: MCP read shape — from operator; acknowledgement not required. ${PLATFORM_SLUG} board thread ${posted.number} shows the body.`,
        ackRequired: false,
        purpose: 'information',
        createdAt: expect.any(String),
      },
    ],
    warning: null,
  })
})
