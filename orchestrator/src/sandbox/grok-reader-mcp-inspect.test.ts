import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { grokReaderMcpInspectionError } from './grok-reader-mcp-inspect.ts'

const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)
const proxy = { project: { command: FRONT_DOOR, args: ['mcp-reader-proxy'] } }
const runConfig = '/run/config.toml'
const source = { type: 'configToml', path: runConfig }
const configSources = { layers: [{ role: 'user', path: runConfig }] }

test('Grok reader inspection accepts exactly platform and proxy servers', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [
          { name: MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: 'project', target: FRONT_DOOR, source },
          { name: 'disabled-cursor', target: '/bin/direct', disabled: true },
        ],
      },
      proxy,
      runConfig,
      [MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME],
    ),
  ).toBeNull()
})

test('Grok reader inspection rejects an extra server and names its source', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [
          { name: 'project', target: FRONT_DOOR, source },
          {
            name: 'alias',
            target: '/bin/direct',
            source: { type: 'mcpJson', path: '/tree/.mcp.json' },
          },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe("Grok reader MCP inspection found unexpected server 'alias' from mcpJson:/tree/.mcp.json")
})

test('Grok reader inspection rejects a same-name direct command and names its source', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [
          {
            name: 'project',
            target: '/bin/direct',
            source,
          },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe(
    'Grok reader MCP inspection found server \'project\' from configToml:/run/config.toml using "/bin/direct" instead of the reader proxy',
  )
})

test('Grok reader inspection rejects a same-command server from the working tree', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          {
            name: 'project',
            target: FRONT_DOOR,
            source: { type: 'configToml', path: '/tree/.grok/config.toml' },
          },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe(
    "Grok reader MCP inspection found server 'project' from configToml:/tree/.grok/config.toml instead of the run home",
  )
})

test('Grok reader inspection rejects missing proxies and platform servers', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [{ name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source }],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe("Grok reader MCP inspection did not find expected server 'project'")
  expect(
    grokReaderMcpInspectionError({ configSources, mcpServers: [] }, proxy, runConfig, [
      WORKER_MCP_SERVER_NAME,
    ]),
  ).toBe(`Grok reader MCP inspection did not find expected server '${WORKER_MCP_SERVER_NAME}'`)
})

test('Grok reader inspection does not require orchestrator when the run home omits it', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources,
        mcpServers: [
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: 'project', target: FRONT_DOOR, source },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBeNull()
})

test('Grok reader inspection rejects a project config layer before server checks', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources: {
          layers: [
            { role: 'user', path: runConfig },
            { role: 'project', path: '/tree/.grok/config.toml' },
          ],
        },
        mcpServers: [
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: 'project', target: FRONT_DOOR, source },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe(
    `Grok reader MCP inspection found config layer 'project' at "/tree/.grok/config.toml" instead of only the run home`,
  )
})

test('Grok reader inspection rejects missing config sources', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        mcpServers: [
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: 'project', target: FRONT_DOOR, source },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe('Grok reader MCP inspection did not report config source layers')
})

test('Grok reader inspection rejects a sole config layer outside the run home', () => {
  expect(
    grokReaderMcpInspectionError(
      {
        configSources: { layers: [{ role: 'project', path: '/tree/.grok/config.toml' }] },
        mcpServers: [
          { name: WORKER_MCP_SERVER_NAME, target: FRONT_DOOR, source },
          { name: 'project', target: FRONT_DOOR, source },
        ],
      },
      proxy,
      runConfig,
      [WORKER_MCP_SERVER_NAME],
    ),
  ).toBe(
    `Grok reader MCP inspection found config layer 'project' at "/tree/.grok/config.toml" instead of only the run home`,
  )
})
