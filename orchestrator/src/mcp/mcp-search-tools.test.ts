import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { registerSearchTools } from './mcp-search-tools.ts'

test("search_docs refuses an invalid scope with the store's message", async () => {
  const server = new McpServer({ name: 'orch-search-test', version: '1.0.0' })
  registerSearchTools(server)
  const client = new Client({ name: 'orch-search-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'meaning', scope: 'invented' },
    })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain(
      'unknown doc scope "invented"; valid scopes:',
    )
  } finally {
    await client.close()
    await server.close()
  }
})
