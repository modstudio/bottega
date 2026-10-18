import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '../agent/agents.ts'
import { grokAskCommandFromConfig, grokAskServerCommand } from '../sandbox/sandbox.ts'
import { prepareClaimedWorkerMcpConfig, prepareWorkerHomeLaunch } from './run-worker-home.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

test('a writer gets cwd-discovered MCP configuration and a reader does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-claimed-mcp-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  const reader = join(root, 'reader')
  const writer = join(root, 'writer')
  mkdirSync(checkout)
  mkdirSync(reader)
  mkdirSync(writer)
  writeFileSync(join(checkout, '.mcp.json'), '{}\n')

  expect(
    prepareClaimedWorkerMcpConfig({
      cwd: reader,
      checkout,
      inherited: false,
      writesRepository: false,
    }),
  ).toBeNull()
  expect(existsSync(join(reader, '.mcp.json'))).toBe(false)

  const prepared = prepareClaimedWorkerMcpConfig({
    cwd: writer,
    checkout,
    inherited: false,
    writesRepository: true,
  })
  expect(prepared?.error).toBeNull()
  expect(readlinkSync(join(writer, '.mcp.json'))).toBe('../checkout/.mcp.json')
})

const grokAgent = { name: 'grok', harness: 'grok' } as Agent

test('Grok launch scopes only a reader home while leaving a writer direct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-grok-launch-'))
  roots.push(root)
  const readerRun = join(root, 'reader-run')
  const reader = join(root, 'reader')
  mkdirSync(readerRun)
  mkdirSync(join(reader, '.grok'), { recursive: true })
  mkdirSync(join(reader, '.cursor'))
  writeFileSync(
    join(readerRun, 'config.toml'),
    '[mcp_servers.project]\ncommand = "user-direct"\n[mcp_servers.alias]\ncommand = "user-alias"\n',
  )
  writeFileSync(
    join(reader, '.grok', 'config.toml'),
    '[mcp_servers.project]\ncommand="tree-direct"\n',
  )
  writeFileSync(join(reader, '.mcp.json'), '{"mcpServers":{"alias":{"command":"mcp-direct"}}}')
  writeFileSync(
    join(reader, '.cursor', 'mcp.json'),
    '{"mcpServers":{"cursor":{"command":"cursor-direct"}}}',
  )
  const proxies = {
    project: {
      command: '/bin/orch',
      args: ['mcp-reader-proxy', 'fixture', 'project', reader],
    },
  }

  const readerLaunch = await prepareWorkerHomeLaunch({
    agent: grokAgent,
    sandbox: 'host',
    runDir: readerRun,
    runId: 41,
    runRecordId: '41000000-0000-4000-8000-000000000000',
    runToken: 'token',
    environment: {},
    grokEnvironment: {},
    includeStore: false,
    codexMcpScope: null,
    grokReaderServers: proxies,
  })
  const readerHome = readFileSync(join(readerRun, 'config.toml'), 'utf8')
  expect(readerHome).toContain('mcp-reader-proxy')
  expect(readerHome).not.toContain('user-direct')
  expect(readerHome).not.toContain('user-alias')
  expect(grokAskCommandFromConfig(readerHome)).toEqual(grokAskServerCommand('host'))
  expect(readFileSync(join(reader, '.grok', 'config.toml'), 'utf8')).toContain('tree-direct')
  expect(readFileSync(join(reader, '.mcp.json'), 'utf8')).toContain('mcp-direct')
  expect(readFileSync(join(reader, '.cursor', 'mcp.json'), 'utf8')).toContain('cursor-direct')
  expect(readerLaunch.environment.GROK_CURSOR_MCPS_ENABLED).toBe('0')

  const writerRun = join(root, 'writer-run')
  const writer = join(root, 'writer')
  mkdirSync(writerRun)
  mkdirSync(writer)
  writeFileSync(
    join(writerRun, 'config.toml'),
    '[mcp_servers.project]\ncommand = "writer-direct"\n',
  )
  writeFileSync(join(writer, '.mcp.json'), '{"mcpServers":{"project":{"command":"writer-tree"}}}')
  const writerLaunch = await prepareWorkerHomeLaunch({
    agent: grokAgent,
    sandbox: 'host',
    runDir: writerRun,
    runId: 42,
    runRecordId: '42000000-0000-4000-8000-000000000000',
    runToken: 'token',
    environment: {},
    grokEnvironment: {},
    includeStore: false,
    codexMcpScope: null,
    grokReaderServers: null,
  })
  expect(readFileSync(join(writerRun, 'config.toml'), 'utf8')).toContain('writer-direct')
  expect(readFileSync(join(writer, '.mcp.json'), 'utf8')).toContain('writer-tree')
  expect(writerLaunch.environment.GROK_CURSOR_MCPS_ENABLED).toBeUndefined()
})
