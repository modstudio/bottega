import { describe, expect, test } from 'bun:test'
import type { McpConnection } from '../mcp/mcp-preflight.ts'
import { decideMcpAttachment, shouldDeferCwdMcpPreflight } from './run-mcp-attachment.ts'

const connected: McpConnection = { server: 'bottega', connected: true, error: null }
const disconnected: McpConnection = {
  server: 'bottega',
  connected: false,
  error: 'connection refused',
}

describe('cwd MCP preflight deferral', () => {
  test.each([
    {
      name: 'a project exists and the job forbids a repository',
      facts: {
        mcpMode: 'require' as const,
        callerCwdHasProject: true,
        forbidsRepo: true,
        repoJob: false,
        discoversMcpFromCwd: false,
      },
      expected: true,
    },
    {
      name: 'a repository job uses an agent that discovers MCP from cwd',
      facts: {
        mcpMode: 'prefer' as const,
        callerCwdHasProject: true,
        forbidsRepo: false,
        repoJob: true,
        discoversMcpFromCwd: true,
      },
      expected: true,
    },
    {
      name: 'no MCP was requested',
      facts: {
        mcpMode: null,
        callerCwdHasProject: true,
        forbidsRepo: true,
        repoJob: true,
        discoversMcpFromCwd: true,
      },
      expected: false,
    },
    {
      name: 'the caller cwd has no project',
      facts: {
        mcpMode: 'require' as const,
        callerCwdHasProject: false,
        forbidsRepo: true,
        repoJob: true,
        discoversMcpFromCwd: true,
      },
      expected: false,
    },
    {
      name: 'the repository agent does not discover MCP from cwd',
      facts: {
        mcpMode: 'require' as const,
        callerCwdHasProject: true,
        forbidsRepo: false,
        repoJob: true,
        discoversMcpFromCwd: false,
      },
      expected: false,
    },
  ])('$name: $expected', ({ facts, expected }) => {
    expect(shouldDeferCwdMcpPreflight(facts)).toBe(expected)
  })
})

describe('MCP attachment ruling', () => {
  test('a refused required attachment returns the existing refusal reason', () => {
    expect(
      decideMcpAttachment({
        connection: disconnected,
        mcpMode: 'require',
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({
      refusalReason:
        "MCP was requested, but server 'bottega' could not be attached: connection refused The agent was not started.",
      usingMcp: false,
    })
  })

  test('a refused preferred attachment continues without MCP', () => {
    expect(
      decideMcpAttachment({
        connection: disconnected,
        mcpMode: 'prefer',
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({ refusalReason: null, usingMcp: false })
  })

  test.each([
    { name: 'no-request', mcpMode: null },
    { name: 'require', mcpMode: 'require' as const },
    { name: 'prefer', mcpMode: 'prefer' as const },
  ])('an agent without MCP cannot use it in $name mode', ({ mcpMode }) => {
    expect(
      decideMcpAttachment({
        connection: connected,
        mcpMode,
        writesJob: true,
        agentHasMcp: false,
      }).usingMcp,
    ).toBe(false)
  })

  test('a writing job uses an available agent MCP capability without an explicit request', () => {
    expect(
      decideMcpAttachment({
        connection: null,
        mcpMode: null,
        writesJob: true,
        agentHasMcp: true,
      }),
    ).toEqual({ refusalReason: null, usingMcp: true })
  })

  test('a non-writing job without an explicit request does not use MCP', () => {
    expect(
      decideMcpAttachment({
        connection: null,
        mcpMode: null,
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({ refusalReason: null, usingMcp: false })
  })
})
