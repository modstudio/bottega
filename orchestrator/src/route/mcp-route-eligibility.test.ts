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

function setMcpMatrix(rows: AgentRow[], codexMcp: boolean): void {
  for (const row of rows) {
    const caps = JSON.parse(row.caps) as Record<string, unknown>
    caps.mcp = row.name === 'codex' ? codexMcp : row.name === 'grok'
    db()
      .query('UPDATE agent SET caps=?, transport=? WHERE name=?')
      .run(JSON.stringify(caps), row.name === 'grok' ? 'acp' : row.transport, row.name)
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

test('required MCP excludes incapable and srt-blocked agents and selects an attachable one', () => {
  const rows = db().query('SELECT name,caps,transport FROM agent').all() as AgentRow[]
  try {
    setMcpMatrix(rows, true)
    const routed = candidates('understand', 0, null, undefined, undefined, null, required)

    expect(routed.find((candidate) => candidate.agent === 'grok')).toMatchObject({
      eligible: false,
      why: 'read-only ACP sandbox selection uses srt, which blocks MCP transports',
    })
    expect(requiredMcpIneligibility({ mcp: false, defaultTransport: 'cli' }, required)).toBe(
      'probed capabilities report mcp=false',
    )
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
    setMcpMatrix(rows, false)

    expect(() => pick('understand', undefined, 0, false, null, { requiredMcp: required })).toThrow(
      /no eligible agent for job "understand"[\s\S]*codex: probed capabilities report mcp=false[\s\S]*grok: read-only ACP sandbox selection uses srt, which blocks MCP transports/,
    )
  } finally {
    restoreAgents(rows)
  }
})

test('MCP preference does not turn attachment into a routing requirement', () => {
  expect(
    requiredMcpIneligibility(
      { mcp: false, defaultTransport: 'cli' },
      {
        ...required,
        mode: 'prefer',
      },
    ),
  ).toBeNull()
})
