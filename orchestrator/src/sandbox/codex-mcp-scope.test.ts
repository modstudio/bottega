// Tests codex-mcp-scope.ts: explicit Codex CLI configuration and MCP grants.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { ROOT } from '../database/database-location.ts'
import {
  CODEX_ASK_ENV_VARS,
  CODEX_ORCH_ENV_VARS,
  CODEX_REASONING_EFFORT,
  codexMcpSetupHeader,
  codexProjectServersFromSelection,
  codexScopeArgs,
  codexWithheldTools,
} from './codex-mcp-scope.ts'
import { selectProjectMcpServers } from './project-mcp-scope.ts'

// Codex renders the launch's single selection; compose it here the way
// run-mcp-launch-scope.ts does so the argv under test is the launch's argv.
function scopeForRun(
  agent: string,
  transport: string,
  mcp: false | 'reader' | 'writer',
  treeConfig: Record<string, Parameters<typeof selectProjectMcpServers>[1][string]>,
  project: Parameters<typeof selectProjectMcpServers>[2],
  cwd: string,
) {
  if (mcp === false) return null
  return codexProjectServersFromSelection(
    selectProjectMcpServers(mcp, treeConfig, project, cwd, true),
    agent,
    transport,
  )
}

const page = (...names: string[]) => ({ tools: names.map((name) => ({ name })) })

test('two pages report page two as withheld (catches reporting the wrong page)', () => {
  const pages = [page('first', 'second'), page('get-rule-tool', 'last')]
  expect(codexWithheldTools(pages)).toEqual({
    seen: 2,
    total: 4,
    withheld: ['get-rule-tool', 'last'],
  })
  expect(
    codexMcpSetupHeader(null, { servers: {}, withheld: [] }, [{ server: 'starship', pages }]),
  ).toBe(
    'MCP scope: codex sees only the first 2 of 4 starship tools; withheld: get-rule-tool, last',
  )
})

test('one page emits no line (catches noise on servers that do not page)', () => {
  expect(
    codexMcpSetupHeader(null, { servers: {}, withheld: [] }, [
      { server: 'starship', pages: [page('only')] },
    ]),
  ).toBeNull()
})

test('failed listing reports catalogue unknown (catches silence on failure)', () => {
  expect(
    codexMcpSetupHeader(null, { servers: {}, withheld: [] }, [
      { server: 'starship', error: 'connection refused' },
    ]),
  ).toBe('MCP scope: starship tools/list failed (connection refused); codex catalogue unknown')
})

function serverEntries(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith('mcp_servers.'))
}

test(`MCP Codex receives only ${WORKER_MCP_SERVER_NAME}, ${MCP_SERVER_NAME}, and its required project server`, () => {
  const home = '/operator'
  const argv = codexScopeArgs({ mcp: true, mcpServer: 'starship', home })
  expect(argv).toContain('--ignore-user-config')
  expect(argv).toContain('features.apps=false')
  expect(argv).toContain('features.plugins=false')
  expect(argv).toContain(`model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`)
  expect(serverEntries(argv).map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    WORKER_MCP_SERVER_NAME,
    MCP_SERVER_NAME,
    'starship',
  ])
  expect(serverEntries(argv).join('\n')).not.toContain('alephbeis')
  expect(argv).toContain(
    `mcp_servers.starship={command=${JSON.stringify(join(home, '.claude/mcp/mcp-run'))},args=["starship"]}`,
  )
})

test('project server overlay takes the place of the mcp-run definition for the same name', () => {
  const projectServer = { command: '/project/scripts/mcp/server', args: [], cwd: '/project' }
  const entries = serverEntries(
    codexScopeArgs({
      mcp: true,
      mcpServer: 'starship',
      home: '/operator',
      projectServers: { starship: projectServer },
    }),
  )
  expect(entries).toContain(
    'mcp_servers.starship={command="/project/scripts/mcp/server",args=[],cwd="/project"}',
  )
  expect(entries.filter((entry) => entry.startsWith('mcp_servers.starship='))).toHaveLength(1)
  expect(entries.join('\n')).not.toContain('.claude/mcp/mcp-run')
})

test('withheld project server suppresses mcp-run while an undeclared server keeps the fallback', () => {
  const withheld = serverEntries(
    codexScopeArgs({
      mcp: true,
      mcpServer: 'starship',
      home: '/operator',
      withheldProjectServers: ['starship'],
    }),
  )
  expect(withheld.some((entry) => entry.startsWith('mcp_servers.starship='))).toBe(false)
  expect(withheld.join('\n')).not.toContain('.claude/mcp/mcp-run')

  const undeclared = serverEntries(
    codexScopeArgs({
      mcp: true,
      mcpServer: 'starship',
      home: '/operator',
      withheldProjectServers: ['different-server'],
    }),
  )
  expect(undeclared).toContain(
    'mcp_servers.starship={command="/operator/.claude/mcp/mcp-run",args=["starship"]}',
  )
})

test('reading-job project overlays all use the credential-free reader proxy', () => {
  const scope = scopeForRun(
    'codex',
    'cli',
    'reader',
    {
      local: { name: 'local', command: '/project/server', args: ['literal-secret'] },
      secret: { name: 'secret', command: '/project/secret', env: { TOKEN: 'literal-secret' } },
    },
    { name: 'starship', path: '/project', settings: { mcpServer: 'secret' } },
    '/project',
  )!
  const entries = serverEntries(
    codexScopeArgs({
      mcp: true,
      mcpServer: 'secret',
      projectServers: scope.servers,
    }),
  )
  const local = entries.find((entry) => entry.startsWith('mcp_servers.local='))!
  const fallback = entries.find((entry) => entry.startsWith('mcp_servers.secret='))!
  for (const entry of [local, fallback]) {
    expect(entry).toContain('reader-proxy')
    expect(entry).toContain('starship')
    expect(entry).toContain('/project')
    expect(entry).not.toContain('literal-secret')
    expect(entry).not.toContain('.claude/mcp/mcp-run')
  }
  expect(
    entries.find((entry) => entry.startsWith(`mcp_servers.${WORKER_MCP_SERVER_NAME}=`)),
  ).toContain('ask-server')
  expect(entries.find((entry) => entry.startsWith(`mcp_servers.${MCP_SERVER_NAME}=`))).toContain(
    'args=["mcp","serve"]',
  )
})

test('reading job without a registered project receives no project servers', () => {
  const scope = scopeForRun(
    'codex',
    'cli',
    'reader',
    { tracker: { name: 'tracker', command: '/project/server', args: ['write'] } },
    null,
    '/unregistered',
  )!
  expect(scope).toEqual({ servers: {}, withheld: [] })
  const entries = serverEntries(codexScopeArgs({ mcp: true, projectServers: scope.servers }))
  expect(entries.map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    WORKER_MCP_SERVER_NAME,
    MCP_SERVER_NAME,
  ])
})

test('platform-shaped MCP scope emits the platform server exactly once', () => {
  const entries = serverEntries(
    codexScopeArgs({ mcp: true, mcpServer: MCP_SERVER_NAME, home: '/operator' }),
  )
  expect(entries.map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    WORKER_MCP_SERVER_NAME,
    MCP_SERVER_NAME,
  ])
  expect(
    entries.filter((entry) => entry.startsWith(`mcp_servers.${MCP_SERVER_NAME}=`)),
  ).toHaveLength(1)
})

test(`non-MCP Codex receives only ${WORKER_MCP_SERVER_NAME}`, () => {
  const argv = codexScopeArgs({ mcp: false, mcpServer: 'starship', home: '/operator' })
  expect(argv).toContain('--ignore-user-config')
  expect(argv).toContain('features.apps=false')
  expect(argv).toContain('features.plugins=false')
  expect(serverEntries(argv).map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    WORKER_MCP_SERVER_NAME,
  ])
  expect(serverEntries(argv)[0]).toContain(`env_vars=${JSON.stringify(CODEX_ASK_ENV_VARS)}`)
})

test(`${WORKER_MCP_SERVER_NAME} CLI definition matches the ACP command and args`, () => {
  const entry = serverEntries(codexScopeArgs({ mcp: true, mcpServer: 'orch' })).find((arg) =>
    arg.startsWith(`mcp_servers.${WORKER_MCP_SERVER_NAME}=`),
  )!
  expect(entry).toContain(`command=${JSON.stringify(join(ROOT, '..', 'bin', PLATFORM_SLUG))}`)
  expect(entry).toContain(`args=${JSON.stringify(['mcp', 'ask-server'])}`)
  expect(entry).toContain(`env_vars=${JSON.stringify(CODEX_ASK_ENV_VARS)}`)
  expect(serverEntries(codexScopeArgs({ mcp: true, mcpServer: 'orch' }))).toContain(
    `mcp_servers.${MCP_SERVER_NAME}={command=${JSON.stringify(join(ROOT, `..`, `bin`, PLATFORM_SLUG))},args=["mcp","serve"],env_vars=${JSON.stringify(CODEX_ORCH_ENV_VARS)}}`,
  )
})

test('resume keeps the complete scope before resume', () => {
  const argv = AGENTS.codex!.resumeArgv!({
    prompt: 'ruling',
    out: '/tmp/out',
    session: 'thread',
    mcp: true,
    mcpServer: 'starship',
    home: '/operator',
  })
  const resume = argv.indexOf('resume')
  for (const expected of ['--ignore-user-config', 'features.apps=false', 'features.plugins=false'])
    expect(argv.indexOf(expected)).toBeLessThan(resume)
  for (const entry of serverEntries(argv)) expect(argv.indexOf(entry)).toBeLessThan(resume)
  expect(serverEntries(argv)).toHaveLength(3)
})
