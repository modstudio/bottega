import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
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
  expect(migrated).toContain(`"${MCP_SERVER_NAME}"`)
  expect(migrated).toContain(`"${WORKER_MCP_SERVER_NAME}"`)
  expect(migrated).toContain(`mcp__${MCP_SERVER_NAME}__get_doc`)
  expect(migrated).not.toContain('"orch":')
  expect(migrated).not.toContain('"orch-ask":')
  expect(migrateMcpConfigText(migrated)).toBe(migrated)
})
