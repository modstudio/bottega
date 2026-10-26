import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { McpConfigReadResult, McpServerConfig } from '../mcp/mcp-probe.ts'
import {
  mcpConfigReadForRun,
  projectReaderProxyServersForRun,
  projectReaderServerNames,
  withholdProjectRelativeStdioServer,
} from './mcp-reader-scope.ts'

const PLATFORM_BINARY = `/opt/${PLATFORM_SLUG}/bin/${PLATFORM_SLUG}`
const server = (name: string): McpServerConfig => ({ name, command: `./bin/${name}` })
const readable = (config: Record<string, McpServerConfig>): McpConfigReadResult => ({
  ok: true,
  path: '/project/.mcp.json',
  config,
})

test('a project-relative stdio command is withheld only when the run has no project tree', () => {
  const relative = { command: 'scripts/mcp/boost' }
  const bare = { command: 'bun' }
  const absolute = { command: '/opt/project/bin/server' }
  const remote = { url: 'https://example.test/mcp' }

  expect(withholdProjectRelativeStdioServer(relative, false)).toBe(true)
  expect(withholdProjectRelativeStdioServer(relative, true)).toBe(false)
  expect(withholdProjectRelativeStdioServer(bare, false)).toBe(false)
  expect(withholdProjectRelativeStdioServer(bare, true)).toBe(false)
  expect(withholdProjectRelativeStdioServer(absolute, false)).toBe(false)
  expect(withholdProjectRelativeStdioServer(absolute, true)).toBe(false)
  expect(withholdProjectRelativeStdioServer(remote, false)).toBe(false)
  expect(withholdProjectRelativeStdioServer(remote, true)).toBe(false)
})

test('a run with no project tree withholds project-relative reader proxies', () => {
  const treeConfig = {
    boost: { name: 'boost', command: 'scripts/mcp/boost' },
    bun: { name: 'bun', command: 'bun' },
    abs: { name: 'abs', command: '/opt/bin/server' },
    remote: { name: 'remote', url: 'https://example.test/mcp' },
  }
  const project = { name: 'starship', path: '/project', settings: {} }
  expect(
    Object.keys(
      projectReaderProxyServersForRun(true, false, treeConfig, project, '/isolate', false) ?? {},
    ),
  ).toEqual(['bun', 'abs', 'remote'])
  expect(
    Object.keys(
      projectReaderProxyServersForRun(true, false, treeConfig, project, '/tree', true) ?? {},
    ),
  ).toEqual(['boost', 'bun', 'abs', 'remote'])
})

test('a reader proxy is synthesized for the servers the resolution starts', () => {
  const config = { starship: server('starship'), stopal: server('stopal') }

  // A project whose checkout never configures its primary gets no proxy for it:
  // a reader proxy rendered for a name nothing starts exits at start.
  expect(projectReaderServerNames(readable(config), undefined, 'orch', PLATFORM_BINARY)).toEqual([
    'starship',
    'stopal',
  ])

  // The platform's own server is served by the installed binary, so its proxy
  // needs no `.mcp.json` entry.
  expect(
    projectReaderServerNames(readable(config), undefined, MCP_SERVER_NAME, PLATFORM_BINARY),
  ).toEqual(['starship', 'stopal', MCP_SERVER_NAME])

  // A configured primary keeps its proxy, even when the allow-list disables it.
  const withPrimary = { ...config, orch: server('orch') }
  expect(
    projectReaderServerNames(readable(withPrimary), ['starship'], 'orch', PLATFORM_BINARY),
  ).toEqual(['starship', 'orch'])
  expect(
    projectReaderServerNames(readable(withPrimary), undefined, 'orch', PLATFORM_BINARY),
  ).toEqual(['starship', 'stopal', 'orch'])
})

test('a launch file that could not be read serves the platform name no reader', () => {
  const path = '/project/.mcp.json'
  // An absent file is no evidence about any name, so the built-in launch stands in.
  expect(
    projectReaderServerNames(
      { ok: false, path, reason: 'missing' },
      undefined,
      MCP_SERVER_NAME,
      PLATFORM_BINARY,
    ),
  ).toEqual([MCP_SERVER_NAME])

  // A broken file names no server: the selection adds no platform reader for it,
  // so a proxy is never rendered for a launch the file never declared.
  for (const reason of ['invalid', 'unreadable'] as const) {
    expect(
      projectReaderServerNames(
        { ok: false, path, reason },
        undefined,
        MCP_SERVER_NAME,
        PLATFORM_BINARY,
      ),
    ).toEqual([])
  }
})

test('the run read keeps why the registered checkout named no server', () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-scope-read-'))
  const path = join(root, '.mcp.json')
  try {
    // A run tree that names servers is what the run resolves against.
    expect(mcpConfigReadForRun({ starship: server('starship') }, { path: root }, '/tree')).toEqual({
      ok: true,
      path: '/tree/.mcp.json',
      config: { starship: server('starship') },
    })

    // With no tree configuration the checkout's file is read, and why it named
    // no server is kept rather than flattened into an empty configuration.
    expect(mcpConfigReadForRun({}, { path: root }, '/tree')).toEqual({
      ok: false,
      path,
      reason: 'missing',
    })
    writeFileSync(path, '{ not json')
    expect(mcpConfigReadForRun({}, { path: root }, '/tree')).toEqual({
      ok: false,
      path,
      reason: 'invalid',
    })
    writeFileSync(path, JSON.stringify({ mcpServers: { tracker: { command: './bin/tracker' } } }))
    const configured = mcpConfigReadForRun({}, { path: root }, '/tree')
    expect(configured.ok).toBe(true)
    if (configured.ok) expect(configured.config.tracker?.command).toBe('./bin/tracker')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
