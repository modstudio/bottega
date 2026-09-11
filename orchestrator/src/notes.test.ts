import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe,expect,test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { createDocsMcpServer } from '../test/fixture.ts'


describe('scoped operator docs', () => {
  test('MCP file_issue refuses a defect missing reproduce_command with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          environment: 'macOS test fixture',
          evidence: 'run 123 failed with exit 1',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('reproduce_command is required')
      expect(message).toContain('exact command that reproduces or demonstrates the issue')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test.each(['evidence', 'not_established'])('MCP file_issue refuses a suggestion missing %s', async (field) => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const arguments_: Record<string, string> = {
        kind: 'suggestion',
        what_happened: 'Issue reports need a direct filing path',
        expected: `A report should land on the ${PLATFORM_SLUG} board`,
        evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
        not_established: 'No priority or assignee has been established',
      }
      delete arguments_[field]
      const filed = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain(`${field} is required`)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP file_issue refuses an unknown reporter kind', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: 'An unrecognised process wants to file',
          expected: 'Only established reporter kinds can file',
          evidence: 'reporter_kind was synthetic',
          not_established: 'No identity contract exists for the synthetic kind',
          reporter_kind: 'synthetic',
        },
      })
      expect(filed.isError).toBe(true)
      expect(((filed as any).content[0] as { text: string }).text).toContain('reporter_kind')
    } finally {
      await client.close()
      await server.close()
    }
  })

})
