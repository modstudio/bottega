import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { scopeGrokReaderMcpHome } from './grok-reader-mcp-home.ts'
import { grokAskCommandFromConfig, grokAskServerCommand } from './sandbox.ts'

const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)

test('Grok reader home replaces project routes with credential-free proxies', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-grok-reader-home-'))
  try {
    mkdirSync(root, { recursive: true })
    const cwd = join(root, 'tree')
    mkdirSync(cwd)
    writeFileSync(
      join(root, 'config.toml'),
      'disabled_mcp_servers = ["stale"]\n' +
        '[mcp_servers.project]\ncommand = "direct"\nargs = ["credential"]\n' +
        '[mcp_servers.alias]\ncommand = "same-project-under-another-name"\n' +
        `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "orch"\n` +
        `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "stale-ask"\n`,
    )
    const proxies = {
      project: {
        command: FRONT_DOOR,
        args: ['mcp-reader-proxy', 'reader', 'fixture', 'project', '/run/tree'],
      },
      secondary: {
        command: FRONT_DOOR,
        args: ['mcp-reader-proxy', 'reader', 'fixture', 'secondary', '/run/tree'],
      },
    }
    mkdirSync(join(cwd, '.grok'))
    mkdirSync(join(cwd, '.cursor'))
    writeFileSync(
      join(cwd, '.grok', 'config.toml'),
      '[mcp_servers.project]\ncommand = "project-direct"\n[mcp_servers.extra]\ncommand = "extra-direct"\n',
    )
    writeFileSync(join(cwd, '.mcp.json'), '{"mcpServers":{"alias":{"command":"direct"}}}\n')
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      '{"mcpServers":{"cursor":{"command":"direct"}}}\n',
    )
    scopeGrokReaderMcpHome(root, 'host', proxies)
    const written = readFileSync(join(root, 'config.toml'), 'utf8')
    expect(written.match(/^disabled_mcp_servers\s*=/gm)).toEqual(['disabled_mcp_servers ='])
    expect(written).not.toContain('credential')
    expect(written).not.toContain('same-project-under-another-name')
    expect(written).toContain(`project = { command = ${JSON.stringify(FRONT_DOOR)}`)
    expect(written).toContain(`secondary = { command = ${JSON.stringify(FRONT_DOOR)}`)
    expect(written).toContain(
      'args = [ "mcp-reader-proxy", "reader", "fixture", "project", "/run/tree" ]',
    )
    expect(written).toContain(`${MCP_SERVER_NAME} = { command = "orch" }`)
    expect(grokAskCommandFromConfig(written)).toEqual(grokAskServerCommand('host'))
    const projectLayer = readFileSync(join(cwd, '.grok', 'config.toml'), 'utf8')
    expect(projectLayer).toContain('project-direct')
    expect(projectLayer).toContain('extra-direct')
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toContain('alias')
    expect(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')).toContain('cursor')

    scopeGrokReaderMcpHome(root, 'host', proxies)
    expect(readFileSync(join(root, 'config.toml'), 'utf8').match(/^project\s*=/gm)).toHaveLength(1)

    scopeGrokReaderMcpHome(root, 'host', {})
    const empty = readFileSync(join(root, 'config.toml'), 'utf8')
    expect(empty).not.toContain('project =')
    expect(empty).not.toContain('alias =')
    expect(empty).toContain(`${MCP_SERVER_NAME} = { command = "orch" }`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
