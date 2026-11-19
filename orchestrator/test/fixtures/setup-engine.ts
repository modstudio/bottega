import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import type { SetupFacts } from '../../src/setup/setup-facts.ts'
import type { McpServer } from '../../src/setup/setup-mcp.ts'

export const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)

export const machine = {
  machineLevel: 'full',
  os: { platform: 'darwin', arch: 'arm64', wsl: false },
  recordApiUrl: 'https://api.example.test',
  recordApiConfigured: true,
  git: { path: '/bin/git', version: '1' },
  gh: { path: '/bin/gh', version: '1', loggedIn: true },
  sandboxRuntime: {
    available: true,
    location: '/runtime',
    missingSystemDependencies: [],
    condition: '',
    remedy: '',
    fixes: [],
    sandboxProbeUnavailableReason: null,
  },
} as unknown as SetupFacts

export function machineWithMcp(
  harness: 'claude' | 'codex' | 'grok' | 'opencode' | 'goose',
  mcp: NonNullable<SetupFacts['harnesses']['codex']['mcp']>,
  auth: SetupFacts['harnesses']['codex']['auth'] = 'signed-in',
): SetupFacts {
  return {
    ...machine,
    harnesses: Object.fromEntries(
      ['claude', 'codex', 'grok', 'opencode', 'goose'].map((name) => [
        name,
        {
          path: name === harness ? `/bin/${name}` : null,
          version: name === harness ? '1' : null,
          auth,
          mcp: name === harness ? mcp : null,
        },
      ]),
    ) as SetupFacts['harnesses'],
  }
}

export const orchServer: McpServer = {
  name: MCP_SERVER_NAME,
  command: FRONT_DOOR,
  args: ['mcp'],
}

export const workerServer: McpServer = {
  name: WORKER_MCP_SERVER_NAME,
  command: FRONT_DOOR,
  args: ['mcp', 'ask-server'],
}
