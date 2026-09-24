import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { McpConnection } from '../mcp/mcp-preflight.ts'
import {
  decideFinalMcpConnection,
  decideMcpAttachment,
  decideMcpMirrorMismatch,
  decideMcpToolProbe,
  shouldDeferCwdMcpPreflight,
} from './run-mcp-attachment.ts'

const mcpServerName = PLATFORM_NAME.toLowerCase()
const projectName = 'bottega'
const connected: McpConnection = {
  server: mcpServerName,
  connected: true,
  error: null,
}
const disconnected: McpConnection = {
  server: mcpServerName,
  connected: false,
  error: 'connection refused',
}

describe('cwd MCP preflight deferral', () => {
  test.each([
    {
      name: 'a project exists and the job forbids a repository',
      facts: {
        mcpRequest: 'require' as const,
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
        mcpRequest: 'prefer' as const,
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
        mcpRequest: undefined,
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
        mcpRequest: 'require' as const,
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
        mcpRequest: 'require' as const,
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
        mcpRequest: 'require',
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({
      mcpMode: 'require',
      refusalReason: `MCP was requested, but server '${mcpServerName}' could not be attached: connection refused The agent was not started.`,
      usingMcp: false,
    })
  })

  test('a refused preferred attachment continues without MCP', () => {
    expect(
      decideMcpAttachment({
        connection: disconnected,
        mcpRequest: 'prefer',
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({ mcpMode: 'prefer', refusalReason: null, usingMcp: false })
  })

  test.each([
    { name: 'no-request', mcpRequest: undefined },
    { name: 'require', mcpRequest: 'require' as const },
    { name: 'prefer', mcpRequest: 'prefer' as const },
  ])('an agent without MCP cannot use it in $name mode', ({ mcpRequest }) => {
    expect(
      decideMcpAttachment({
        connection: connected,
        mcpRequest,
        writesJob: true,
        agentHasMcp: false,
      }).usingMcp,
    ).toBe(false)
  })

  test('a writing job uses an available agent MCP capability without an explicit request', () => {
    expect(
      decideMcpAttachment({
        connection: null,
        mcpRequest: undefined,
        writesJob: true,
        agentHasMcp: true,
      }),
    ).toEqual({ mcpMode: null, refusalReason: null, usingMcp: true })
  })

  test('a non-writing job without an explicit request does not use MCP', () => {
    expect(
      decideMcpAttachment({
        connection: null,
        mcpRequest: undefined,
        writesJob: false,
        agentHasMcp: true,
      }),
    ).toEqual({ mcpMode: null, refusalReason: null, usingMcp: false })
  })
})

describe('MCP mirror attachment ruling', () => {
  test('a required wrong-project mirror produces the existing refusal', () => {
    const mismatch = decideMcpMirrorMismatch(mcpServerName, ['other'], 'require')
    expect(mismatch?.connection.error).toBe(`wrong project: saw other and not ${mcpServerName}`)
    expect(mismatch?.refusalReason).toBe(
      `MCP was requested, but server '${mcpServerName}' could not be attached: wrong project: saw other and not ${mcpServerName} The agent was not started.`,
    )
  })

  test('a preferred wrong-project mirror continues with its mirror diagnostic', () => {
    const mismatch = decideMcpMirrorMismatch(mcpServerName, ['other'], 'prefer')
    expect(mismatch?.refusalReason).toBeNull()
    expect(mismatch?.continuedConnection.error).toBe(
      `mirror: wrong project: saw other and not ${mcpServerName}`,
    )
  })

  test('the required server is not a mismatch', () => {
    expect(decideMcpMirrorMismatch(mcpServerName, [mcpServerName], 'require')).toBeNull()
  })
})

describe('MCP tool-probe attachment ruling', () => {
  test('a successful required orch probe launches with worker attachment unverified', () => {
    const ruling = decideMcpToolProbe(
      {
        server: mcpServerName,
        tool: 'ping',
        ok: true,
        error: null,
        durationMs: 1,
        detail: 'called ping',
        namesSeen: [mcpServerName],
      },
      mcpServerName,
      'require',
      'codex',
      projectName,
    )
    expect(ruling.callEvidence).toEqual({
      connected: null,
      error: 'orch probe ok: ping; worker attachment unverified',
    })
    expect(ruling.refusalReason).toBeNull()
    expect(ruling.failedConnection).toBeNull()
  })

  test('an unobservable required probe is refused with the existing guidance', () => {
    const ruling = decideMcpToolProbe(
      {
        server: mcpServerName,
        tool: 'tools/list',
        ok: true,
        error: 'no probe tool configured',
        durationMs: 1,
        detail: null,
        namesSeen: [mcpServerName],
      },
      mcpServerName,
      'require',
      'codex',
      projectName,
    )
    expect(ruling.refusalReason).toContain('mcp unverifiable on codex')
    expect(ruling.refusalReason).toContain(`orch project set ${projectName}`)
    expect(ruling.failedConnection).toBeNull()
  })

  test('a failed preferred probe continues without attachment', () => {
    const ruling = decideMcpToolProbe(
      {
        server: mcpServerName,
        tool: 'ping',
        ok: false,
        error: 'call failed',
        durationMs: 1,
        detail: null,
        namesSeen: [mcpServerName],
      },
      mcpServerName,
      'prefer',
      'codex',
      projectName,
    )
    expect(ruling.refusalReason).toBeNull()
    expect(ruling.failedConnection).toEqual({
      server: mcpServerName,
      connected: false,
      error: 'call failed',
      namesSeen: [mcpServerName],
    })
  })
})

describe('final worker MCP evidence', () => {
  const preLaunchEvidence = {
    server: mcpServerName,
    connected: true,
    error: 'grok mcp doctor healthy; worker attachment unverified',
  }

  test('healthy doctor evidence alone stays unverified', () => {
    expect(
      decideFinalMcpConnection({
        requiredServer: mcpServerName,
        mcpMode: 'require',
        preLaunchEvidence,
        workerEvents: [],
      }),
    ).toEqual({ connected: null, error: preLaunchEvidence.error, requiredFailure: null })
  })

  test('a completed worker call on the required server verifies attachment', () => {
    expect(
      decideFinalMcpConnection({
        requiredServer: mcpServerName,
        mcpMode: 'require',
        preLaunchEvidence,
        workerEvents: [
          {
            kind: 'tool',
            toolKind: 'mcp',
            server: mcpServerName,
            title: 'task_list',
            status: 'completed',
          },
        ],
      }),
    ).toEqual({
      connected: 1,
      error: `verified: worker tool call ${mcpServerName}.task_list`,
      requiredFailure: null,
    })
  })

  test.each([
    {
      name: 'required',
      mcpMode: 'require' as const,
      requiredFailure: `MCP server '${mcpServerName}' was unreachable to the worker: authentication failed`,
    },
    { name: 'preferred', mcpMode: 'prefer' as const, requiredFailure: null },
  ])('a failed worker call is recorded in $name mode', ({ mcpMode, requiredFailure }) => {
    expect(
      decideFinalMcpConnection({
        requiredServer: mcpServerName,
        mcpMode,
        preLaunchEvidence,
        workerEvents: [
          {
            kind: 'tool',
            toolKind: 'mcp',
            server: mcpServerName,
            title: 'task_list',
            status: 'failed',
            error: 'authentication failed',
          },
        ],
      }),
    ).toEqual({
      connected: 0,
      error: 'authentication failed',
      requiredFailure,
    })
  })

  test('a call on another server does not verify the required server', () => {
    expect(
      decideFinalMcpConnection({
        requiredServer: mcpServerName,
        mcpMode: 'require',
        preLaunchEvidence,
        workerEvents: [
          {
            kind: 'tool',
            toolKind: 'mcp',
            server: 'other',
            title: 'task_list',
            status: 'completed',
          },
        ],
      }).connected,
    ).toBeNull()
  })
})
