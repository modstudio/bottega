import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { McpServerConfig } from '../mcp/mcp-probe.ts'
import { projectReaderServerNames } from './mcp-reader-scope.ts'

const PLATFORM_BINARY = `/opt/${PLATFORM_SLUG}/bin/${PLATFORM_SLUG}`
const server = (name: string): McpServerConfig => ({ name, command: `./bin/${name}` })

test('a reader proxy is synthesized for the servers the resolution starts', () => {
  const config = { starship: server('starship'), stopal: server('stopal') }

  // A project whose checkout never configures its primary gets no proxy for it:
  // a reader proxy rendered for a name nothing starts exits at start.
  expect(projectReaderServerNames(config, undefined, 'orch', PLATFORM_BINARY)).toEqual([
    'starship',
    'stopal',
  ])

  // The platform's own server is served by the installed binary, so its proxy
  // needs no `.mcp.json` entry.
  expect(projectReaderServerNames(config, undefined, MCP_SERVER_NAME, PLATFORM_BINARY)).toEqual([
    'starship',
    'stopal',
    MCP_SERVER_NAME,
  ])

  // A configured primary keeps its proxy, even when the allow-list disables it.
  const withPrimary = { ...config, orch: server('orch') }
  expect(projectReaderServerNames(withPrimary, ['starship'], 'orch', PLATFORM_BINARY)).toEqual([
    'starship',
    'orch',
  ])
  expect(projectReaderServerNames(withPrimary, undefined, 'orch', PLATFORM_BINARY)).toEqual([
    'starship',
    'stopal',
    'orch',
  ])
})
