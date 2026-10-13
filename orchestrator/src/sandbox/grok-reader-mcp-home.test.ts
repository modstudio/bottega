import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grokAskCommandFromConfig, grokAskServerCommand } from './sandbox.ts'
import { scopeGrokReaderMcpHome } from './grok-reader-mcp-home.ts'

test('Grok reader home replaces project routes with credential-free proxies', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-grok-reader-home-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'config.toml'),
      'disabled_mcp_servers = ["stale"]\n' +
        '[mcp_servers.project]\ncommand = "direct"\nargs = ["credential"]\n' +
        '[mcp_servers.alias]\ncommand = "same-project-under-another-name"\n' +
        '[mcp_servers.orch]\ncommand = "orch"\n' +
        '[mcp_servers.orch-ask]\ncommand = "stale-ask"\n',
    )
    const proxies = {
      project: {
        command: '/bin/orch',
        args: ['mcp-reader-proxy', 'fixture', 'project', '/run/tree'],
      },
      secondary: {
        command: '/bin/orch',
        args: ['mcp-reader-proxy', 'fixture', 'secondary', '/run/tree'],
      },
    }
    scopeGrokReaderMcpHome(root, 'host', proxies)
    const written = readFileSync(join(root, 'config.toml'), 'utf8')
    expect(written.match(/^disabled_mcp_servers\s*=/gm)).toEqual(['disabled_mcp_servers ='])
    expect(written).not.toContain('credential')
    expect(written).not.toContain('same-project-under-another-name')
    expect(written).toContain('project = { command = "/bin/orch"')
    expect(written).toContain('secondary = { command = "/bin/orch"')
    expect(written).toContain('args = [ "mcp-reader-proxy", "fixture", "project", "/run/tree" ]')
    expect(written).toContain('orch = { command = "orch" }')
    expect(grokAskCommandFromConfig(written)).toEqual(grokAskServerCommand('host'))

    scopeGrokReaderMcpHome(root, 'host', proxies)
    expect(readFileSync(join(root, 'config.toml'), 'utf8').match(/^project\s*=/gm)).toHaveLength(1)

    scopeGrokReaderMcpHome(root, 'host', {})
    const empty = readFileSync(join(root, 'config.toml'), 'utf8')
    expect(empty).not.toContain('project =')
    expect(empty).not.toContain('alias =')
    expect(empty).toContain('orch = { command = "orch" }')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
