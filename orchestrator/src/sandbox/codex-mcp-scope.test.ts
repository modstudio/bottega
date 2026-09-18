// Tests codex-mcp-scope.ts: explicit Codex CLI configuration and MCP grants.
import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { AGENTS } from '../agent/agent-registry.ts'
import { ROOT } from '../database/database-location.ts'
import {
  CODEX_ASK_ENV_VARS,
  CODEX_REASONING_EFFORT,
  codexMcpSetupHeader,
  codexProjectServers,
  codexScopeArgs,
  codexWithheldTools,
} from './codex-mcp-scope.ts'

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

test('MCP Codex receives only orch-ask, orch, and its required project server', () => {
  const home = '/operator'
  const argv = codexScopeArgs({ mcp: true, mcpServer: 'starship', home })
  expect(argv).toContain('--ignore-user-config')
  expect(argv).toContain('features.apps=false')
  expect(argv).toContain('features.plugins=false')
  expect(argv).toContain(`model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`)
  expect(serverEntries(argv).map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    'orch-ask',
    'orch',
    'starship',
  ])
  expect(serverEntries(argv).join('\n')).not.toContain('alephbeis')
  expect(argv).toContain(
    `mcp_servers.starship={command=${JSON.stringify(join(home, '.claude/mcp/mcp-run'))},args=["starship"]}`,
  )
})

test('project MCP scope selects allowed credential-free launch definitions', () => {
  const cwd = '/project'
  const scope = codexProjectServers(
    {
      relative: { name: 'relative', command: 'scripts/mcp/server', args: ['serve'] },
      bare: { name: 'bare', command: 'npx' },
      remote: { name: 'remote', url: 'https://mcp.example.test' },
      secretHeader: {
        name: 'secretHeader',
        url: 'https://secret.test',
        headers: { Authorization: 'token' },
      },
      secretEnv: { name: 'secretEnv', command: 'node', env: { TOKEN: '${TOKEN}' } },
      excluded: { name: 'excluded', command: 'bash' },
    },
    ['relative', 'bare', 'remote', 'secretHeader', 'secretEnv'],
    cwd,
  )
  expect(scope).toEqual({
    servers: {
      relative: { command: join(cwd, 'scripts/mcp/server'), args: ['serve'], cwd },
      bare: { command: 'npx', args: [], cwd },
      remote: { url: 'https://mcp.example.test' },
    },
    withheld: ['secretHeader', 'secretEnv'],
  })
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

test('platform-shaped MCP scope emits orch exactly once', () => {
  const entries = serverEntries(codexScopeArgs({ mcp: true, mcpServer: 'orch', home: '/operator' }))
  expect(entries.map((entry) => entry.match(/^mcp_servers\.([^=]+)/)![1])).toEqual([
    'orch-ask',
    'orch',
  ])
  expect(entries.filter((entry) => entry.startsWith('mcp_servers.orch='))).toHaveLength(1)
})

test('non-MCP Codex stays isolated from user config without server entries', () => {
  const argv = codexScopeArgs({ mcp: false, mcpServer: 'starship', home: '/operator' })
  expect(argv).toContain('--ignore-user-config')
  expect(argv).toContain('features.apps=false')
  expect(argv).toContain('features.plugins=false')
  expect(serverEntries(argv)).toEqual([])
})

test('orch-ask CLI definition matches the ACP command and args', () => {
  const entry = serverEntries(codexScopeArgs({ mcp: true, mcpServer: 'orch' })).find((arg) =>
    arg.startsWith('mcp_servers.orch-ask='),
  )!
  expect(entry).toContain(`command=${JSON.stringify(process.execPath)}`)
  expect(entry).toContain(
    `args=${JSON.stringify([join(dirname(import.meta.path), '..', 'cli', 'orch.ts'), 'ask-server'])}`,
  )
  expect(entry).toContain(`env_vars=${JSON.stringify(CODEX_ASK_ENV_VARS)}`)
  expect(serverEntries(codexScopeArgs({ mcp: true, mcpServer: 'orch' }))).toContain(
    `mcp_servers.orch={command=${JSON.stringify(join(ROOT, '..', 'bin', 'orch'))},args=["mcp"]}`,
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
