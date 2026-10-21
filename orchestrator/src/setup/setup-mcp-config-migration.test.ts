import { expect, test } from 'bun:test'
import { migrateMcpConfigText } from './setup-mcp-config-migration.ts'

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
  expect(migrated).toContain('"bottega"')
  expect(migrated).toContain('"bottega-ask"')
  expect(migrated).toContain('mcp__bottega__get_doc')
  expect(migrated).not.toContain('"orch":')
  expect(migrated).not.toContain('"orch-ask":')
  expect(migrateMcpConfigText(migrated)).toBe(migrated)
})
