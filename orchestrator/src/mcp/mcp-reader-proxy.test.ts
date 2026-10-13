import { expect, test } from 'bun:test'
import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client'
import {
  createReaderMcpProxy,
  type ReaderMcpUpstream,
  readerMayCallTool,
} from './mcp-reader-proxy.ts'

const decision = (overrides: Partial<Parameters<typeof readerMayCallTool>[0]> = {}) =>
  readerMayCallTool({
    name: 'read',
    readOnlyHint: undefined,
    server: 'project',
    projectServer: 'project',
    registeredTools: [],
    ...overrides,
  })

test('reader tool decision accepts register names on any server', () => {
  expect(decision({ server: 'other', registeredTools: ['read'] })).toBeTrue()
})

test('reader tool decision accepts annotations only from the project own server', () => {
  expect(decision({ readOnlyHint: true })).toBeTrue()
  expect(decision({ server: 'other', readOnlyHint: true })).toBeFalse()
})

test('reader tool decision refuses absent and false annotations', () => {
  expect(decision()).toBeFalse()
  expect(decision({ readOnlyHint: false })).toBeFalse()
})

test('proxy exhausts listing pages, refuses guessed names, and forwards allowed calls unchanged', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const pages: Array<{ tools: Tool[]; nextCursor?: string }> = [
    {
      tools: [
        { name: 'annotated', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'write', inputSchema: { type: 'object' } },
      ],
      nextCursor: 'page-two',
    },
    { tools: [{ name: 'registered', inputSchema: { type: 'object' } }] },
  ]
  const returned = {
    content: [{ type: 'text' as const, text: 'same result' }],
    structuredContent: { same: true },
  }
  const upstream: ReaderMcpUpstream = {
    listTools: async (cursor) => pages[cursor ? 1 : 0]!,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return returned
    },
    close: async () => {},
  }
  const proxy = await createReaderMcpProxy(upstream, {
    server: 'project',
    projectServer: 'project',
    registeredTools: ['registered'],
  })
  const client = new Client({ name: 'reader-proxy-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await proxy.server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'annotated',
      'registered',
    ])
    const refused = await client.callTool({ name: 'guessed-write', arguments: { unsafe: true } })
    expect(refused.isError).toBeTrue()
    expect(refused.content).toEqual([
      { type: 'text', text: 'Reading job may not call tool "guessed-write".' },
    ])
    expect(calls).toEqual([])

    const result = await client.callTool({ name: 'registered', arguments: { value: 7 } })
    expect(result).toEqual(returned)
    expect(calls).toEqual([{ name: 'registered', args: { value: 7 } }])
  } finally {
    await client.close()
    await proxy.close()
  }
})
