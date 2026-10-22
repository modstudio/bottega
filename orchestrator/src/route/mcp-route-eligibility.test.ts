import { expect, test } from 'bun:test'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { type RequiredMcpServer, requiredMcpIneligibility } from '../mcp/mcp-compatibility.ts'
import { candidates, pick } from './route.ts'

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

test('required MCP ignores the probe flag, excludes an unconfirmable native attachment, and selects an attachable one', () => {
  const rows = db().query('SELECT name,caps,transport FROM agent').all() as AgentRow[]
  try {
    setMcpMatrix(rows, 'cli')
    const routed = candidates('understand', 0, null, undefined, undefined, null, required)

    expect(routed.find((candidate) => candidate.agent === 'grok')).toMatchObject({
      eligible: false,
      why: 'native project MCP attachment is unconfirmable: ACP session launch does not attach project servers',
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

test('required MCP refuses when no agent can attach the project server', () => {
  const rows = db().query('SELECT name,caps,transport FROM agent').all() as AgentRow[]
  try {
    setMcpMatrix(rows, 'acp')

    expect(() => pick('understand', undefined, 0, false, null, { requiredMcp: required })).toThrow(
      /no eligible agent for job "understand"[\s\S]*codex: native project MCP attachment is unconfirmable: ACP session launch does not attach project servers[\s\S]*grok: native project MCP attachment is unconfirmable: ACP session launch does not attach project servers/,
    )
  } finally {
    restoreAgents(rows)
  }
})

test('MCP preference does not turn attachment into a routing requirement', () => {
  expect(
    requiredMcpIneligibility(
      { name: 'goose-agent', harness: 'goose', defaultTransport: 'acp' },
      {
        ...required,
        mode: 'prefer',
      },
    ),
  ).toBeNull()
})
