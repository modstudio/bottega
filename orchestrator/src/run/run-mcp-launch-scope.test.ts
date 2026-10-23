import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '../agent/agents.ts'
import type { ProjectMcpSelection } from '../sandbox/project-mcp-scope.ts'
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

const launch = (agent: string, transport: string, usingMcp: boolean, cwd: string) =>
  workerMcpLaunchScope({
    agent: { name: agent, harness: agent } as Agent,
    transport,
    usingMcp,
    writesJob: true,
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
  expect(scope.projectSelection).toEqual({ kind: 'direct', servers: {}, withheld: ['secret'] })
  expect(JSON.stringify(scope.projectSelection)).not.toContain('literal-secret')
})

test('the selection-only entry derives the same selection as a full launch scope', () => {
  const cwd = tree({ local: { command: './bin/local', args: ['--serve'] } })
  const writes = workerMcpLaunchSelection({ usingMcp: true, writesJob: true, callerCwd: cwd, cwd })
  expect(writes).toEqual(launch('goose', 'acp', true, cwd).projectSelection)
  const reads = workerMcpLaunchSelection({ usingMcp: true, writesJob: false, callerCwd: cwd, cwd })
  expect(reads?.kind).toBe('reader')
  expect(
    workerMcpLaunchSelection({ usingMcp: false, writesJob: true, callerCwd: cwd, cwd }),
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

test('only a transport that renders the selection reports the servers it withheld', () => {
  const selection: ProjectMcpSelection = { kind: 'direct', servers: {}, withheld: ['secret'] }
  expect(withheldScopeLine('acp', 'goose', selection)).toBe(
    'MCP scope: goose withheld secret (inline env/headers or no launch definition)',
  )
  // Codex CLI renders its own header, and any other CLI renders no selection.
  expect(withheldScopeLine('cli', 'codex', selection)).toBeNull()
  expect(withheldScopeLine('cli', 'opencode', selection)).toBeNull()
  expect(withheldScopeLine('acp', 'goose', null)).toBeNull()
})
