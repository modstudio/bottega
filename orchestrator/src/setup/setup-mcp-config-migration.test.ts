import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { migrateMcpConfigText } from './setup-mcp-config.ts'
import { captureMcpConfigMigrations } from './setup-mcp-config-migration.ts'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('migrates server and tool permission names once without leaving aliases', () => {
  const original = JSON.stringify({
    mcpServers: {
      orch: { command: '/bin/orch', args: ['mcp', 'serve'] },
      'orch-ask': { command: '/bin/orch', args: ['mcp', 'ask-server'] },
    },
    permissions: { allow: ['mcp__orch__get_doc'] },
    projects: {
      '/work/project': {
        mcpServers: { orch: { command: '/project/server' } },
        allowedTools: ['mcp__orch__list_projects'],
      },
    },
  })
  const migrated = migrateMcpConfigText(original)
  expect(migrated).toContain(`"${MCP_SERVER_NAME}"`)
  expect(migrated).toContain(`"${WORKER_MCP_SERVER_NAME}"`)
  expect(migrated).toContain(`mcp__${MCP_SERVER_NAME}__get_doc`)
  expect(migrated).not.toContain('"orch":')
  expect(migrated).not.toContain('"orch-ask":')
  expect(migrateMcpConfigText(migrated)).toBe(migrated)
})

test('reports malformed candidates while still capturing valid sibling migrations without contents', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-mcp-home-'))
  const project = mkdtempSync(join(tmpdir(), 'setup-mcp-project-'))
  temporary.push(home, project)
  mkdirSync(join(project, '.claude'))
  const malformed = join(project, '.claude', 'settings.json')
  const valid = join(project, '.claude', 'settings.local.json')
  const sentinel = 'credential-must-not-leak'
  writeFileSync(malformed, '{not json')
  writeFileSync(
    valid,
    JSON.stringify({ credential: sentinel, permissions: { allow: ['mcp__orch__get_doc'] } }),
  )

  const result = captureMcpConfigMigrations(home, [project])

  expect(result.notices).toHaveLength(1)
  expect(result.notices[0]?.path).toBe(malformed)
  expect(result.notices[0]?.error).toContain('JSON')
  expect(result.migrations).toHaveLength(1)
  expect(result.migrations[0]).toEqual({
    path: valid,
    summary: {
      serverKeysRenamed: [],
      toolPrefixKeysRewritten: 0,
      toolPrefixValuesRewritten: 1,
    },
  })
  expect(JSON.stringify(result)).not.toContain(sentinel)
})

test('skips a project configuration symlink that resolves outside its checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-mcp-home-'))
  const project = mkdtempSync(join(tmpdir(), 'setup-mcp-project-'))
  const outside = mkdtempSync(join(tmpdir(), 'setup-mcp-outside-'))
  temporary.push(home, project, outside)
  const target = join(outside, 'settings.json')
  writeFileSync(target, JSON.stringify({ permissions: { allow: ['mcp__orch__get_doc'] } }))
  symlinkSync(target, join(project, '.mcp.json'))

  const result = captureMcpConfigMigrations(home, [project])

  expect(result.migrations).toEqual([])
  expect(result.notices).toEqual([
    {
      path: join(project, '.mcp.json'),
      error: expect.stringContaining('is outside project checkout'),
    },
  ])
})
