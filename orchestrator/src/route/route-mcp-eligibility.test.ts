import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import type { Agent } from '../agent/agents.ts'
import type { McpServerConfig } from '../mcp/mcp-probe.ts'
import { upsertProject } from '../project/projects.ts'
import {
  PROJECT_MCP_WRITER_TOOLS_ADVICE,
  PROJECT_MCP_WRITER_WITHHELD_REASON,
  requiredProjectMcpWriterIneligibility,
} from '../sandbox/project-mcp-scope.ts'
import { mcpCandidateIneligibility, pick } from './route.ts'

beforeEach(() => seedNeutralCodexQuotaReading())

const AGENT_CASES: Array<
  Pick<Agent, 'name' | 'harness' | 'defaultTransport' | 'mcpToolNamePattern'>
> = [
  { name: 'grok', harness: 'grok', defaultTransport: 'cli' },
  { name: 'goose-agent', harness: 'goose', defaultTransport: 'acp' },
  { name: 'codex', harness: 'codex', defaultTransport: 'cli' },
]

const SERVER_CASES: Array<{
  shape: string
  config: McpServerConfig
  withheld: boolean
}> = [
  {
    shape: 'helper-auth URL',
    config: {
      name: 'starship',
      url: 'https://example.test/mcp',
      headersHelper: './headers',
    },
    withheld: true,
  },
  {
    shape: 'bearer URL',
    config: {
      name: 'starship',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer fixture-token' },
    },
    withheld: true,
  },
  {
    shape: 'header URL',
    config: {
      name: 'starship',
      url: 'https://example.test/mcp',
      headers: { 'X-Fixture': 'fixture-value' },
    },
    withheld: true,
  },
  {
    shape: 'auth-free URL',
    config: { name: 'starship', url: 'https://example.test/mcp' },
    withheld: false,
  },
  {
    shape: 'command',
    config: { name: 'starship', command: './server' },
    withheld: false,
  },
]

test.each(AGENT_CASES.flatMap((agent) => SERVER_CASES.map((server) => ({ agent, ...server }))))(
  '$agent.harness is decided against a $shape writer server',
  ({ agent, config, withheld }) => {
    const why = mcpCandidateIneligibility(
      agent,
      {
        projectId: '00000000-0000-4000-8000-000000000001',
        project: 'starship',
        server: 'starship',
        mode: 'require',
      },
      undefined,
      undefined,
      undefined,
      requiredProjectMcpWriterIneligibility(
        'starship',
        'require',
        true,
        config,
        {
          name: 'starship',
          path: '/project',
          settings: {},
        },
        {
          harness: agent.harness ?? agent.name,
          transport: agent.defaultTransport ?? 'cli',
        },
      ),
    )

    if (withheld) {
      expect(why).toContain("required project MCP server 'starship' is withheld")
      expect(why).toContain('inline env/headers, a headersHelper, or no launch definition')
    } else {
      expect(why).toBeNull()
    }
  },
)

test.each(AGENT_CASES)('$harness remains eligible for a helper-auth reader server', (agent) => {
  expect(
    mcpCandidateIneligibility(
      agent,
      {
        projectId: '00000000-0000-4000-8000-000000000001',
        project: 'starship',
        server: 'starship',
        mode: 'require',
      },
      undefined,
      undefined,
      undefined,
      requiredProjectMcpWriterIneligibility('starship', 'require', false, SERVER_CASES[0]!.config, {
        name: 'starship',
        path: '/project',
        settings: {},
      }),
    ),
  ).toBeNull()
})

test.each(AGENT_CASES)(
  '$harness applies writer proxy eligibility to a declared writer tool',
  (agent) => {
    const why = requiredProjectMcpWriterIneligibility(
      'starship',
      'require',
      true,
      SERVER_CASES[0]!.config,
      {
        name: 'starship',
        path: '/project',
        settings: { mcp: { writer_tools: { starship: ['update-task'] } } },
      },
      {
        harness: agent.harness ?? agent.name,
        transport: agent.defaultTransport ?? 'cli',
      },
    )
    if (agent.defaultTransport === 'acp') {
      expect(why).toContain('ACP writers do not receive proxied project servers yet')
    } else {
      expect(why).toBeNull()
    }
  },
)

test('a starship-shaped required writer server refuses routing before dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-starship-route-'))
  const recordId = newRecordId()
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          starship: {
            url: 'https://example.test/mcp',
            headersHelper: './scripts/mcp-headers',
          },
        },
      }),
    )
    upsertProject({
      recordId,
      name: 'starship-route-fixture',
      path: root,
      settings: { mcpServer: 'starship' },
    })
    const requiredMcp = {
      projectId: recordId,
      project: 'starship-route-fixture',
      server: 'starship',
      mode: 'require' as const,
    }

    const route = () =>
      pick(
        'implement',
        undefined,
        0,
        false,
        null,
        { requiredMcp, project: 'starship-route-fixture' },
        false,
        undefined,
        Math.random,
        { allowHarness: false },
      )
    expect(route).toThrow(
      `required project MCP server 'starship' is withheld from writing workers (${PROJECT_MCP_WRITER_WITHHELD_REASON})`,
    )
    expect(route).toThrow(PROJECT_MCP_WRITER_TOOLS_ADVICE.replace('<server>', 'starship'))
    expect(route).toThrow(join(root, '.mcp.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
