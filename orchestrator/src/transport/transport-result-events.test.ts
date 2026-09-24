import { describe, expect, test } from 'bun:test'
import { decideFinalMcpConnection } from '../run/run-mcp-attachment.ts'
import { cliResultEvents } from './transport-result-events.ts'

const server = 'starship'
const preLaunchEvidence = {
  server,
  connected: true,
  error: 'orch probe ok: task_list; worker attachment unverified',
}

describe('CLI streamed MCP evidence', () => {
  test('a completed tool call reaches the final connection ruling', () => {
    const events = cliResultEvents(
      [
        {
          kind: 'tool',
          toolKind: 'mcp',
          server,
          title: 'task_list',
          status: 'completed',
        },
      ],
      [{ kind: 'text', text: 'done' }],
    )

    expect(
      decideFinalMcpConnection({
        requiredServer: server,
        mcpMode: 'require',
        preLaunchEvidence,
        workerEvents: events,
      }),
    ).toEqual({
      connected: 1,
      error: 'verified: worker tool call starship.task_list',
      requiredFailure: null,
    })
  })

  test('a failed tool call reaches the required failure ruling', () => {
    const events = cliResultEvents(
      [
        {
          kind: 'tool',
          toolKind: 'mcp',
          server,
          title: 'task_list',
          status: 'failed',
          error: 'handshake failed',
        },
      ],
      [{ kind: 'text', text: 'done' }],
    )

    expect(
      decideFinalMcpConnection({
        requiredServer: server,
        mcpMode: 'require',
        preLaunchEvidence,
        workerEvents: events,
      }).requiredFailure,
    ).toBe("MCP server 'starship' was unreachable to the worker: handshake failed")
  })
})
