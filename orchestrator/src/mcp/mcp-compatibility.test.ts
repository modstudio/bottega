import { describe, expect, test } from 'bun:test'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { candidates, pick } from '../route/route.ts'
import {
  decideMcpCompatibility,
  decideMcpGrammarRuling,
  type RequiredMcpServer,
} from './mcp-compatibility.ts'
import { decideRequiredMcpAttachment, requiredMcpIneligibility } from './mcp-native-attachment.ts'

const grok = '^[A-Za-z0-9_-]{1,64}$'

describe('MCP tool-name compatibility', () => {
  test('dotted names are incompatible with the grok grammar', () => {
    expect(decideMcpCompatibility(['workflow.list', 'task.get'], grok).verdict).toBe('incompatible')
  })

  test('an absent grammar translates dotted names', () => {
    expect(decideMcpCompatibility(['workflow.list'], undefined).verdict).toBe('compatible')
  })

  test('a mixed catalogue is partial', () => {
    expect(decideMcpCompatibility(['workflow.list', 'workflow_list'], grok).verdict).toBe('partial')
  })

  test('an absent listing is unknown', () => {
    expect(decideMcpCompatibility(undefined, grok)).toEqual({
      listed: null,
      admitted: null,
      verdict: 'unknown',
    })
  })

  test('the pre-launch backstop refuses require and degrades prefer', () => {
    expect(
      decideMcpGrammarRuling({
        mode: 'require',
        server: 'stopal',
        listedTools: ['workflow.list', 'task.get'],
        pattern: grok,
      }).refusal,
    ).toBe(
      "MCP server 'stopal' tool-name grammar is incompatible: 0/2 admitted by ^[A-Za-z0-9_-]{1,64}$; re-dispatch to route to a compatible agent",
    )
    expect(
      decideMcpGrammarRuling({
        mode: 'prefer',
        server: 'stopal',
        listedTools: ['workflow.list', 'task.get'],
        pattern: grok,
      }),
    ).toEqual({
      routingIneligibility: null,
      refusal: null,
      failedConnection:
        "MCP server 'stopal' tool-name grammar is incompatible: 0/2 admitted by ^[A-Za-z0-9_-]{1,64}$",
    })
  })
})

const required: RequiredMcpServer = {
  projectId: 'project-id',
  project: 'project',
  server: 'project',
  mode: 'require',
}

type AgentRow = { name: string; caps: string; transport: string }

function setMcpMatrix(rows: AgentRow[], codexTransport: 'cli' | 'acp'): void {
  for (const row of rows) {
    const caps = JSON.parse(row.caps) as Record<string, unknown>
    caps.mcp = row.name === 'grok'
    const transport =
      row.name === 'codex' ? codexTransport : row.name === 'grok' ? 'acp' : row.transport
    db()
      .query('UPDATE agent SET caps=?, transport=? WHERE name=?')
      .run(JSON.stringify(caps), transport, row.name)
  }
  refreshAgents()
}

function restoreAgents(rows: AgentRow[]): void {
  for (const row of rows) {
    db()
      .query('UPDATE agent SET caps=?, transport=? WHERE name=?')
      .run(row.caps, row.transport, row.name)
  }
  refreshAgents()
}

describe('required MCP routing', () => {
  test('ignores the probe flag, excludes an unconfirmable native attachment, and selects an attachable one', () => {
    const rows = db().query('SELECT name,caps,transport FROM agent').all() as AgentRow[]
    try {
      setMcpMatrix(rows, 'cli')
      const routed = candidates('understand', 0, null, undefined, undefined, null, required)

      expect(routed.find((candidate) => candidate.agent === 'grok')).toMatchObject({
        eligible: false,
        why: 'native project MCP attachment is unconfirmable: ACP session launch attaches only the ask server, not project servers; re-dispatch on an agent that attaches natively (--agent codex) or drop --mcp',
      })
      expect(
        requiredMcpIneligibility({ name: 'codex', defaultTransport: 'cli' }, required),
      ).toBeNull()
      expect(pick('understand', undefined, 0, false, null, { requiredMcp: required }).agent).toBe(
        'codex',
      )
    } finally {
      restoreAgents(rows)
    }
  })

  test('refuses when no agent can attach the project server', () => {
    const rows = db().query('SELECT name,caps,transport FROM agent').all() as AgentRow[]
    try {
      setMcpMatrix(rows, 'acp')

      expect(() =>
        pick('understand', undefined, 0, false, null, {
          requiredMcp: required,
          pinnedTransport: 'acp',
          transportPinSource: 'explicit',
        }),
      ).toThrow(
        /no eligible agent for job "understand"[\s\S]*codex: native project MCP attachment is unconfirmable: ACP session launch attaches only the ask server, not project servers; re-dispatch with --transport cli or drop --mcp[\s\S]*grok: native project MCP attachment is unconfirmable: ACP session launch attaches only the ask server, not project servers; re-dispatch with --transport cli or drop --mcp/,
      )
    } finally {
      restoreAgents(rows)
    }
  })

  test('preference does not turn attachment into a routing requirement', () => {
    expect(
      requiredMcpIneligibility(
        { name: 'goose-agent', harness: 'goose', defaultTransport: 'acp' },
        { ...required, mode: 'prefer' },
      ),
    ).toBeNull()
  })

  test.each([
    {
      name: 'a pinned ACP transport',
      defaultTransport: 'cli' as const,
      pinnedTransport: 'acp' as const,
      confirmable: false,
    },
    {
      name: 'a pinned CLI transport',
      defaultTransport: 'acp' as const,
      pinnedTransport: 'cli' as const,
      confirmable: true,
    },
    {
      name: 'the agent default when transport is unpinned',
      defaultTransport: 'acp' as const,
      pinnedTransport: undefined,
      confirmable: false,
    },
  ])(
    'resolves native attachment against $name',
    ({ defaultTransport, pinnedTransport, confirmable }) => {
      const reason = requiredMcpIneligibility({ name: 'codex', defaultTransport }, required, {
        transport: pinnedTransport,
        source: pinnedTransport ? 'explicit' : undefined,
      })
      expect(reason === null).toBe(confirmable)
    },
  )

  test.each([
    {
      name: 'explicit ACP pin',
      pin: { transport: 'acp' as const, source: 'explicit' as const },
      remedy: 're-dispatch with --transport cli or drop --mcp',
    },
    {
      name: 'environment ACP pin',
      pin: { transport: 'acp' as const, source: 'environment' as const },
      remedy: 'unset ORCH_TRANSPORT and re-dispatch with --transport cli, or drop --mcp',
    },
    {
      name: 'unpinned transport',
      pin: {},
      remedy: 're-dispatch on an agent that attaches natively (--agent codex) or drop --mcp',
    },
  ])('builds the effective remedy once for $name', ({ pin, remedy }) => {
    const decision = decideRequiredMcpAttachment({
      mode: 'require',
      prediction: { confirmable: false, reason: 'not attachable' },
      pin,
    })
    expect(decision).toEqual({
      confirmable: false,
      routingIneligibility: `not attachable; ${remedy}`,
      refusalReason: `not attachable; ${remedy}`,
    })
  })
})
