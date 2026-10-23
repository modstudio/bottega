import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import type { McpServerConfig } from '../mcp/mcp-probe.ts'
import {
  mergeMcpSetupHeader,
  projectMcpWithheldLine,
  selectProjectMcpServers,
} from './project-mcp-scope.ts'

const CONFIG: Record<string, McpServerConfig> = {
  local: { name: 'local', command: './bin/local', args: ['--serve'] },
  remote: { name: 'remote', url: 'https://example.test/mcp' },
  secretEnv: { name: 'secretEnv', command: 'secret-env', env: { TOKEN: 'literal-secret' } },
  secretHeader: {
    name: 'secretHeader',
    url: 'https://example.test/secret',
    headers: { Authorization: 'literal-secret' },
  },
  noLaunch: { name: 'noLaunch' },
}
const PROJECT = { name: 'starship', path: '/project', settings: {} }

test('a writing run attaches every project server except the withheld ones', () => {
  const selection = selectProjectMcpServers('writer', CONFIG, PROJECT, '/project')
  expect(selection?.kind).toBe('direct')
  if (selection?.kind !== 'direct') return
  expect(selection.servers.local).toEqual({
    command: '/project/bin/local',
    args: ['--serve'],
    cwd: '/project',
  })
  expect(selection.servers.remote).toEqual({ url: 'https://example.test/mcp' })
  expect(selection.withheld).toEqual(['secretEnv', 'secretHeader', 'noLaunch'])
  expect(JSON.stringify(selection)).not.toContain('literal-secret')
})

test('a reading run attaches the credential-free reader proxy and withholds nothing', () => {
  const selection = selectProjectMcpServers('reader', CONFIG, PROJECT, '/project')
  expect(selection?.kind).toBe('reader')
  if (selection?.kind !== 'reader') return
  expect(Object.keys(selection.servers)).toContain('local')
  expect(Object.keys(selection.servers)).toContain('remote')
  expect(selection.servers.local!.args).toContain('reader-proxy')
  expect(selection.servers.local!.args).toContain('starship')
  expect(selection.withheld).toEqual([])
  expect(JSON.stringify(selection)).not.toContain('literal-secret')
})

test('the run allowlist decides which servers attach and is checked before withholding', () => {
  const selection = selectProjectMcpServers(
    'writer',
    CONFIG,
    { ...PROJECT, settings: { workerMcpServers: ['local', 'secretEnv'] } },
    '/project',
  )
  expect(selection?.kind).toBe('direct')
  expect(Object.keys(selection?.servers ?? {})).toEqual(['local'])
  expect(selection?.withheld).toEqual(['secretEnv'])
})

test('a project config never occupies a platform MCP identity', () => {
  const config: Record<string, McpServerConfig> = {
    [MCP_SERVER_NAME]: { name: MCP_SERVER_NAME, command: '/evil/platform' },
    [WORKER_MCP_SERVER_NAME]: {
      name: WORKER_MCP_SERVER_NAME,
      url: 'https://attacker.invalid/mcp',
    },
    local: { name: 'local', command: './bin/local' },
  }
  const direct = selectProjectMcpServers('writer', config, PROJECT, '/project')
  expect(direct?.kind).toBe('direct')
  if (direct?.kind !== 'direct') return
  expect(Object.keys(direct.servers)).toEqual(['local'])
  expect(direct.withheld).toEqual([])
  const reader = selectProjectMcpServers('reader', config, PROJECT, '/project')
  expect(Object.keys(reader?.servers ?? {})).not.toContain(WORKER_MCP_SERVER_NAME)
  expect(Object.keys(reader?.servers ?? {})).not.toContain(MCP_SERVER_NAME)
})

test('MCP off attaches no project server at all', () => {
  expect(selectProjectMcpServers(false, CONFIG, PROJECT, '/project')).toBeNull()
})

test('withheld names are reported in the harness that loses them, and not when none are', () => {
  expect(projectMcpWithheldLine('goose', [])).toBeNull()
  expect(projectMcpWithheldLine('goose', ['a', 'b'])).toBe(
    'MCP scope: goose withheld a, b (inline env/headers or no launch definition)',
  )
})

test('the withheld line merges into a setup header and adds none of its own', () => {
  expect(mergeMcpSetupHeader(null, null)).toBeNull()
  expect(mergeMcpSetupHeader('existing', null)).toBe('existing')
  expect(mergeMcpSetupHeader(null, 'MCP scope: goose withheld a')).toBe(
    'MCP scope: goose withheld a',
  )
  expect(mergeMcpSetupHeader('existing', 'MCP scope: goose withheld a')).toBe(
    'existing\nMCP scope: goose withheld a',
  )
})
