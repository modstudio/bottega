// concern: Grok reader MCP home
/** Replaces every non-platform user MCP route with run-scoped reader proxies. */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from '@decimalturn/toml-patch'
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import {
  grokReaderMcpServerTable,
  type ProjectMcpServerEntry,
  READER_PLATFORM_MCP_SERVERS,
} from './mcp-reader-scope.ts'
import { grokSandboxConfig, type RunSandbox } from './sandbox.ts'

/** Rewrite the already-provisioned run home without retaining an undetectable server alias. */
export function scopeGrokReaderMcpHome(
  runDir: string,
  sandbox: RunSandbox,
  servers: Record<string, ProjectMcpServerEntry>,
): { configPath: string; platformServers: string[] } {
  const target = join(runDir, 'config.toml')
  const parsed = parseToml(readFileSync(target, 'utf8')) as Record<string, unknown>
  const userServers = parsed.mcp_servers as Record<string, unknown> | undefined
  parsed.disabled_mcp_servers = []
  parsed.mcp_servers = grokReaderMcpServerTable(userServers, servers)
  writeFileSync(target, grokSandboxConfig(stringifyToml(parsed), sandbox), { mode: 0o600 })
  chmodSync(target, 0o600)
  return {
    configPath: target,
    platformServers: READER_PLATFORM_MCP_SERVERS.filter(
      (name) => name === WORKER_MCP_SERVER_NAME || Boolean(userServers?.[name]),
    ),
  }
}
