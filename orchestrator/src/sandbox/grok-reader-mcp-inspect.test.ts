import { expect, test } from 'bun:test'
import { grokReaderMcpInspectionError } from './grok-reader-mcp-inspect.ts'

const proxy = { project: { command: '/bin/orch', args: ['mcp-reader-proxy'] } }

test('Grok reader inspection accepts exactly platform and proxy servers', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        mcpServers: [
          { name: 'orch', target: '/bin/orch' },
          { name: 'orch-ask', target: '/bin/orch' },
          { name: 'project', target: '/bin/orch' },
          { name: 'disabled-cursor', target: '/bin/direct', disabled: true },
        ],
      },
      proxy,
    ),
  ).toBeNull()
})

test('Grok reader inspection rejects an extra server and names its source', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        mcpServers: [
          { name: 'project', target: '/bin/orch' },
          {
            name: 'alias',
            target: '/bin/direct',
            source: { type: 'mcpJson', path: '/tree/.mcp.json' },
          },
        ],
      },
      proxy,
    ),
  ).toBe("Grok reader MCP inspection found unexpected server 'alias' from mcpJson:/tree/.mcp.json")
})

test('Grok reader inspection rejects a same-name direct command and names its source', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        mcpServers: [
          {
            name: 'project',
            target: '/bin/direct',
            source: { type: 'configToml', path: '/tree/.grok/config.toml' },
          },
        ],
      },
      proxy,
    ),
  ).toBe(
    'Grok reader MCP inspection found server \'project\' from configToml:/tree/.grok/config.toml using "/bin/direct" instead of the reader proxy',
  )
})
