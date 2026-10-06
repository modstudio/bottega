import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { registerSearchTools } from './mcp-search-tools.ts'

test('search_docs accepts and forwards optional address filters', async () => {
  const seen: unknown[] = []
  const server = new McpServer({ name: 'orch-search-test', version: '1.0.0' })
  registerSearchTools(server, {
    searchDocs: async (query, k, filter) => {
      seen.push({ query, k, filter })
      return {
        query,
        k,
        contract: { model: 'model', dimension: 1024, instructionVersion: 'doc-search-v1' },
        refresh: { embedded: 0, deleted: 0, unchanged: 0, stale: 0 },
        results: [],
      }
    },
  })
  const client = new Client({ name: 'orch-search-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'meaning', k: 3, scope: 'canon', subject: 'bottega' },
    })
    expect(result.isError).not.toBe(true)
    expect(seen).toEqual([
      { query: 'meaning', k: 3, filter: { scope: 'canon', subject: 'bottega' } },
    ])
  } finally {
    await client.close()
    await server.close()
  }
})
