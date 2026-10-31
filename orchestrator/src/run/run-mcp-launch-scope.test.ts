import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import type { Agent } from '../agent/agents.ts'
import { upsertProject } from '../project/projects.ts'
import { PROJECT_RELATIVE_NO_TREE_REASON } from '../sandbox/mcp-reader-scope.ts'
import {
  PROJECT_MCP_WRITER_WITHHELD_ADVICE,
  PROJECT_MCP_WRITER_WITHHELD_REASON,
  type ProjectMcpSelection,
  projectMcpWriterRemedy,
  selectProjectMcpServers,
} from '../sandbox/project-mcp-scope.ts'
import { acpProjectMcpServers } from '../transport/transport-acp-mcp.ts'
import {
  PROJECT_MCP_ACP_WRITER_ADVICE,
  projectSelectionForLaunch,
  withheldScopeLine,
  workerMcpLaunchScope,
  workerMcpLaunchSelection,
  writerProxyRoute,
} from './run-mcp-launch-scope.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function tree(servers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-mcp-launch-'))
  roots.push(root)
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  return root
}

const launch = (
  agent: string,
  transport: string,
  usingMcp: boolean,
  cwd: string,
  opts?: { writesJob?: boolean; hasProjectTree?: boolean },
) =>
  workerMcpLaunchScope({
    agent: { name: agent, harness: agent } as Agent,
    transport,
    usingMcp,
    writesJob: opts?.writesJob ?? true,
    hasProjectTree: opts?.hasProjectTree ?? true,
    callerCwd: cwd,
    cwd,
    connection: null,
  })

test('a writing launch reads the tree and names the same direct server for every harness', () => {
  const cwd = tree({ local: { command: './bin/local', args: ['--serve'] } })
  const codex = launch('codex', 'cli', true, cwd)
  expect(Object.keys(codex.config)).toEqual(['local'])
  expect(codex.projectSelection).toEqual({
    kind: 'direct',
    servers: { local: { command: join(cwd, 'bin/local'), args: ['--serve'], cwd } },
    withheld: [],
  })
  expect(codex.codex?.servers).toEqual({
    local: { command: join(cwd, 'bin/local'), args: ['--serve'], cwd },
  })

  const goose = launch('goose', 'acp', true, cwd)
  expect(goose.projectSelection).toEqual(codex.projectSelection)
  expect(goose.codex).toBeNull()
})

test('inline credentials are withheld from the selection rather than rendered', () => {
  const cwd = tree({ secret: { command: 'secret-env', env: { TOKEN: 'literal-secret' } } })
  const scope = launch('goose', 'acp', true, cwd)
  expect(scope.projectSelection).toEqual({
    kind: 'direct',
    servers: {},
    withheld: [
      {
        name: 'secret',
        reason: PROJECT_MCP_WRITER_WITHHELD_REASON,
        advice: PROJECT_MCP_ACP_WRITER_ADVICE,
        remedy: projectMcpWriterRemedy(null),
      },
    ],
  })
  expect(JSON.stringify(scope.projectSelection)).not.toContain('literal-secret')
})

test('a Grok CLI writer receives its credentialed project server through the writer proxy', () => {
  const cwd = tree({
    tracker: { command: 'tracker-server', env: { TRACKER_TOKEN: 'literal-secret' } },
  })
  execFileSync('git', ['init', '--quiet'], { cwd })
  upsertProject({
    recordId: newRecordId(),
    name: 'grok-writer-proxy-fixture',
    path: cwd,
    settings: { mcp: { writer_tools: { tracker: ['update-task'] } } },
  })
  const scope = launch('grok', 'cli', true, cwd)
  expect(scope.projectSelection?.withheld).toEqual([])
  expect(scope.grok?.tracker).toMatchObject({
    args: expect.arrayContaining(['writer', 'grok-writer-proxy-fixture', 'tracker', cwd]),
  })
  expect(JSON.stringify(scope.grok)).not.toContain('literal-secret')
  expect(scope.credentialLines).toHaveLength(1)
  expect(scope.credentialLines[0]).toContain('project grok-writer-proxy-fixture MCP server tracker')
  expect(scope.credentialLines[0]).toContain('env TRACKER_TOKEN')
  expect(scope.credentialLines[0]).not.toContain('literal-secret')
  expect(scope.credentialLines[0]).not.toContain('${')
})

test('the selection-only entry derives the same selection as a full launch scope', () => {
  const cwd = tree({ local: { command: './bin/local', args: ['--serve'] } })
  const writes = workerMcpLaunchSelection({
    usingMcp: true,
    writesJob: true,
    hasProjectTree: true,
    callerCwd: cwd,
    cwd,
    writerProxy: writerProxyRoute('goose', 'acp'),
  })
  expect(writes).toEqual(launch('goose', 'acp', true, cwd).projectSelection)
  const reads = workerMcpLaunchSelection({
    usingMcp: true,
    writesJob: false,
    hasProjectTree: true,
    callerCwd: cwd,
    cwd,
    writerProxy: writerProxyRoute('goose', 'acp'),
  })
  expect(reads?.kind).toBe('reader')
  expect(
    workerMcpLaunchSelection({
      usingMcp: false,
      writesJob: true,
      hasProjectTree: true,
      callerCwd: cwd,
      cwd,
      writerProxy: writerProxyRoute('goose', 'acp'),
    }),
  ).toBeNull()
})

test('a run downgraded off MCP after the selection was decided attaches nothing on ACP', () => {
  const cwd = tree({ local: { command: './bin/local', args: ['--serve'] } })
  const scope = launch('goose', 'acp', true, cwd)
  const downgraded = projectSelectionForLaunch(false, scope.projectSelection)
  expect(downgraded).toBeNull()
  expect(acpProjectMcpServers(downgraded)).toEqual([])
})

test('MCP off leaves every rendering empty', () => {
  const cwd = tree({ local: { command: './bin/local' } })
  const scope = launch('codex', 'cli', false, cwd)
  expect(scope.projectSelection).toBeNull()
  expect(scope.codex).toBeNull()
  expect(scope.allowlist).toEqual([])
})

test('only a transport or harness that renders the selection reports the servers it withheld', () => {
  const selection: ProjectMcpSelection = {
    kind: 'direct',
    servers: {},
    withheld: [
      {
        name: 'secret',
        reason: PROJECT_MCP_WRITER_WITHHELD_REASON,
        advice: PROJECT_MCP_WRITER_WITHHELD_ADVICE,
      },
    ],
  }
  expect(withheldScopeLine('acp', 'goose', selection)).toBe(
    'MCP scope: goose withheld secret (inline env/headers, a headersHelper, or no launch definition); writing workers cannot receive these; run as a reader through the proxy, or declare the server without them',
  )
  // Codex CLI renders its own header. Grok CLI rewrites its run home from the
  // selection, so it gets this line. Any other CLI renders no selection.
  expect(withheldScopeLine('cli', 'codex', selection)).toBeNull()
  expect(withheldScopeLine('cli', 'grok', selection)).toBe(
    'MCP scope: grok withheld secret (inline env/headers, a headersHelper, or no launch definition); writing workers cannot receive these; run as a reader through the proxy, or declare the server without them',
  )
  expect(withheldScopeLine('cli', 'opencode', selection)).toBeNull()
  expect(withheldScopeLine('acp', 'goose', null)).toBeNull()
})

test('a Grok CLI reader reports a project-relative server withheld without a tree', () => {
  const selection = selectProjectMcpServers(
    'reader',
    {
      boost: { name: 'boost', command: 'scripts/mcp/boost' },
      bun: { name: 'bun', command: 'bun' },
    },
    { name: 'starship', path: '/project', settings: {} },
    '/isolate',
    false,
    writerProxyRoute('grok', 'cli'),
  )
  expect(selection?.kind).toBe('reader')
  expect((selection?.withheld ?? []).map((entry) => entry.name)).toEqual(['boost'])
  const line = withheldScopeLine('cli', 'grok', selection)
  expect(line).toContain('boost')
  expect(line).toContain(PROJECT_RELATIVE_NO_TREE_REASON)
})
