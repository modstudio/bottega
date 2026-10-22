import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupPlan } from './setup-engine.ts'
import { LEGACY_MCP_TOOL_PREFIX } from './setup-mcp-config.ts'
import { addMcpConfigMigrations } from './setup-service.ts'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('a malformed project MCP configuration becomes a notice while valid siblings still migrate', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-service-home-'))
  const project = mkdtempSync(join(tmpdir(), 'setup-service-project-'))
  temporary.push(home, project)
  mkdirSync(join(project, '.claude'))
  const malformed = join(project, '.claude', 'settings.json')
  const valid = join(project, '.claude', 'settings.local.json')
  writeFileSync(malformed, '{not json')
  writeFileSync(
    valid,
    JSON.stringify({ permissions: { allow: [`${LEGACY_MCP_TOOL_PREFIX}get_doc`] } }),
  )
  const plan = { notices: [] } as unknown as SetupPlan

  addMcpConfigMigrations(plan, home, [project])

  expect(plan.notices).toHaveLength(1)
  expect(plan.notices[0]?.message).toContain(malformed)
  expect(plan.notices[0]?.message).toContain('JSON')
  expect(plan.notices[0]?.fix).toContain('fix or remove')
  expect(plan.mcpConfigMigrations?.map((migration) => migration.path)).toEqual([valid])
})
