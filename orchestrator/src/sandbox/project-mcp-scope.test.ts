import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import type { McpServerConfig } from '../mcp/mcp-probe.ts'
import {
  PROJECT_RELATIVE_NO_TREE_REASON,
  PROJECT_RELATIVE_NO_TREE_REMEDY,
} from './mcp-reader-scope.ts'
import {
  mergeMcpSetupHeader,
  PROJECT_MCP_ACP_WRITER_ADVICE,
  PROJECT_MCP_WRITER_TOOLS_ADVICE,
  PROJECT_MCP_WRITER_WITHHELD_REASON,
  projectMcpWithheldLine,
  projectMcpWriterRemedy,
  selectProjectMcpServers,
} from './project-mcp-scope.ts'

const writerWithheld = (...names: string[]) =>
  names.map((name) => ({
    name,
    reason: PROJECT_MCP_WRITER_WITHHELD_REASON,
    advice: PROJECT_MCP_WRITER_TOOLS_ADVICE.replace('<server>', name),
    remedy: projectMcpWriterRemedy(PROJECT),
  }))

const CONFIG: Record<string, McpServerConfig> = {
  local: { name: 'local', command: './bin/local', args: ['--serve'] },
  remote: { name: 'remote', url: 'https://example.test/mcp' },
  secretEnv: { name: 'secretEnv', command: 'secret-env', env: { TOKEN: 'literal-secret' } },
  secretHeader: {
    name: 'secretHeader',
    url: 'https://example.test/secret',
    headers: { Authorization: 'literal-secret' },
  },
  helperHeader: {
    name: 'helperHeader',
    url: 'https://example.test/helper',
    headersHelper: './headers helperHeader',
  },
  noLaunch: { name: 'noLaunch' },
}
const PROJECT = { name: 'starship', path: '/project', settings: {} }

test('a writing run attaches every project server except the withheld ones', () => {
  const selection = selectProjectMcpServers('writer', CONFIG, PROJECT, '/project', true)
  expect(selection?.kind).toBe('direct')
  if (selection?.kind !== 'direct') return
  expect(selection.servers.local).toEqual({
    command: '/project/bin/local',
    args: ['--serve'],
    cwd: '/project',
  })
  expect(selection.servers.remote).toEqual({ url: 'https://example.test/mcp' })
  expect(selection.withheld).toEqual(
    writerWithheld('secretEnv', 'secretHeader', 'helperHeader', 'noLaunch'),
  )
  expect(JSON.stringify(selection)).not.toContain('literal-secret')
})

test('a credentialed writer server uses a credential-free proxy only with declared writer tools', () => {
  const project = {
    ...PROJECT,
    settings: { mcp: { writer_tools: { secretHeader: ['update-task'] } } },
  }
  const selection = selectProjectMcpServers('writer', CONFIG, project, '/project', true)
  expect(selection?.kind).toBe('direct')
  expect(selection?.servers.secretHeader).toMatchObject({
    args: expect.arrayContaining(['writer', 'starship', 'secretHeader', '/project']),
  })
  expect(selection?.withheld.map(({ name }) => name)).toEqual([
    'secretEnv',
    'helperHeader',
    'noLaunch',
  ])
  expect(JSON.stringify(selection)).not.toContain('literal-secret')

  const acp = selectProjectMcpServers('writer', CONFIG, project, '/project', true, 'acp')
  expect(acp?.servers.secretHeader).toBeUndefined()
  expect(acp?.withheld.find(({ name }) => name === 'secretHeader')?.advice).toBe(
    PROJECT_MCP_ACP_WRITER_ADVICE,
  )
  expect(JSON.stringify(acp)).not.toContain('literal-secret')
})

test('a reading run attaches the credential-free reader proxy and withholds nothing', () => {
  const selection = selectProjectMcpServers('reader', CONFIG, PROJECT, '/project', true)
  expect(selection?.kind).toBe('reader')
  if (selection?.kind !== 'reader') return
  expect(Object.keys(selection.servers)).toContain('local')
  expect(Object.keys(selection.servers)).toContain('remote')
  expect(selection.servers.local!.args).toContain('reader-proxy')
  expect(selection.servers.local!.args).toContain('starship')
  expect(selection.withheld).toEqual([])
  expect(JSON.stringify(selection)).not.toContain('literal-secret')
})

test('a reading run with no project tree withholds project-relative stdio servers', () => {
  const selection = selectProjectMcpServers(
    'reader',
    {
      boost: { name: 'boost', command: 'scripts/mcp/boost' },
      bun: { name: 'bun', command: 'bun' },
      abs: { name: 'abs', command: '/opt/bin/server' },
      remote: { name: 'remote', url: 'https://example.test/mcp' },
    },
    PROJECT,
    '/isolate',
    false,
  )
  expect(selection?.kind).toBe('reader')
  if (selection?.kind !== 'reader') return
  expect(Object.keys(selection.servers)).toEqual(['bun', 'abs', 'remote'])
  expect(selection.withheld).toEqual([
    {
      name: 'boost',
      reason: PROJECT_RELATIVE_NO_TREE_REASON,
      remedy: PROJECT_RELATIVE_NO_TREE_REMEDY,
    },
  ])
})

test('a reading run of the project that owns the platform server is handed its proxy with no tree entry', () => {
  const selection = selectProjectMcpServers(
    'reader',
    {},
    { name: PLATFORM_SLUG, path: '/project', settings: {} },
    '/project',
    true,
  )
  expect(selection?.kind).toBe('reader')
  if (selection?.kind !== 'reader') return
  expect(Object.keys(selection.servers)).toEqual([MCP_SERVER_NAME])
  expect(selection.servers[MCP_SERVER_NAME]!.args.slice(-3)).toEqual([
    PLATFORM_SLUG,
    MCP_SERVER_NAME,
    '/project',
  ])
})

test('the run allowlist decides which servers attach and is checked before withholding', () => {
  const selection = selectProjectMcpServers(
    'writer',
    CONFIG,
    { ...PROJECT, settings: { workerMcpServers: ['local', 'secretEnv'] } },
    '/project',
    true,
  )
  expect(selection?.kind).toBe('direct')
  expect(Object.keys(selection?.servers ?? {})).toEqual(['local'])
  expect(selection?.withheld).toEqual(writerWithheld('secretEnv'))
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
  const direct = selectProjectMcpServers('writer', config, PROJECT, '/project', true)
  expect(direct?.kind).toBe('direct')
  if (direct?.kind !== 'direct') return
  expect(Object.keys(direct.servers)).toEqual(['local'])
  expect(direct.withheld).toEqual([])
  const reader = selectProjectMcpServers('reader', config, PROJECT, '/project', true)
  expect(Object.keys(reader?.servers ?? {})).not.toContain(WORKER_MCP_SERVER_NAME)
  expect(Object.keys(reader?.servers ?? {})).not.toContain(MCP_SERVER_NAME)
})

test('MCP off attaches no project server at all', () => {
  expect(selectProjectMcpServers(false, CONFIG, PROJECT, '/project', true)).toBeNull()
})

test('withheld names are reported in the harness that loses them, and not when none are', () => {
  expect(projectMcpWithheldLine('goose', [])).toBeNull()
  expect(projectMcpWithheldLine('goose', writerWithheld('a', 'b'))).toBe(
    'MCP scope: goose withheld a, b (inline env/headers, a headersHelper, or no launch definition)',
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
