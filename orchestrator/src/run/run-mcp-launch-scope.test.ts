import { afterEach, expect, test } from 'bun:test'
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
} from '../sandbox/project-mcp-scope.ts'
import { acpProjectMcpServers } from '../transport/transport-acp-mcp.ts'
import {
  projectSelectionForLaunch,
  withheldScopeLine,
  workerMcpLaunchScope,
  workerMcpLaunchSelection,
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

function registeredTree(servers: Record<string, unknown>): string {
  const cwd = tree(servers)
  const initialized = Bun.spawnSync(['git', 'init', '--quiet'], { cwd })
  if (initialized.exitCode !== 0) {
    throw new Error(initialized.stderr.toString().trim() || 'git init failed')
  }
  upsertProject({
    recordId: newRecordId(),
    name: 'starship',
    path: cwd,
    settings: {},
  })
  return cwd
}

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
        advice: PROJECT_MCP_WRITER_WITHHELD_ADVICE,
        remedy: projectMcpWriterRemedy(null),
      },
    ],
  })
  expect(JSON.stringify(scope.projectSelection)).not.toContain('literal-secret')
})

test('the selection-only entry derives the same selection as a full launch scope', () => {
  const cwd = tree({ local: { command: './bin/local', args: ['--serve'] } })
  const writes = workerMcpLaunchSelection({
    usingMcp: true,
    writesJob: true,
    hasProjectTree: true,
    callerCwd: cwd,
    cwd,
  })
  expect(writes).toEqual(launch('goose', 'acp', true, cwd).projectSelection)
  const reads = workerMcpLaunchSelection({
    usingMcp: true,
    writesJob: false,
    hasProjectTree: true,
    callerCwd: cwd,
    cwd,
  })
  expect(reads?.kind).toBe('reader')
  expect(
    workerMcpLaunchSelection({
      usingMcp: false,
      writesJob: true,
      hasProjectTree: true,
      callerCwd: cwd,
      cwd,
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
  const cwd = registeredTree({
    boost: { command: 'scripts/mcp/boost' },
    bun: { command: 'bun' },
  })
  const scope = launch('grok', 'cli', true, cwd, { writesJob: false, hasProjectTree: false })
  expect(scope.projectSelection?.kind).toBe('reader')
  expect(scope.projectSelection?.withheld.map((entry) => entry.name)).toEqual(['boost'])
  const line = withheldScopeLine('cli', 'grok', scope.projectSelection)
  expect(line).toContain('boost')
  expect(line).toContain(PROJECT_RELATIVE_NO_TREE_REASON)
})
