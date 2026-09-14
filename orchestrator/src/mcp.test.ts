import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'
import { missingIssueReportFields } from './issue-report-fields.ts'
import { createDocsMcpServer } from './mcp.ts'

describe('orch MCP', () => {
  test('file_issue advertises every accepted input field', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const fileIssue = (await client.listTools()).tools.find((tool) => tool.name === 'file_issue')
      expect(Object.keys(fileIssue?.inputSchema.properties ?? {}).sort()).toEqual([
        'affected_project', 'environment', 'evidence', 'expected', 'kind',
        'monitor_invocation_id', 'not_established', 'reporter_kind', 'reporting_project',
        'reproduce_command', 'title', 'what_happened',
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('file_issue refuses a defect missing reproduce_command', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'file_issue', arguments: {
        kind: 'defect', what_happened: 'The command failed', expected: 'The command succeeds',
        environment: 'macOS test fixture', evidence: 'run 123 failed with exit 1',
        not_established: 'The underlying cause is not established',
      } })
      expect(result.isError).toBe(true)
      expect(((result as any).content[0] as { text: string }).text).toContain(
        'reproduce_command is required: provide the exact command that reproduces or demonstrates the issue',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('kind-dependent fields have exact missing sets', () => {
    const completeSuggestion = {
      kind: 'suggestion' as const,
      what_happened: 'Expose more filing guidance',
      expected: 'Clients can construct a report without validation retries',
      evidence: 'The advertised schema contains the common report fields',
      not_established: 'Whether clients render every description',
    }
    expect(missingIssueReportFields({ kind: 'defect' })).toEqual([
      'reproduce_command', 'environment',
    ])
    expect(missingIssueReportFields({ kind: 'defect', reproduce_command: 'bun run check' }))
      .toEqual(['environment'])
    expect(missingIssueReportFields(completeSuggestion)).toEqual([])
  })
})
