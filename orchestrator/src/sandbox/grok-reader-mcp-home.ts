// concern: Grok reader MCP home
/** Replaces every non-platform user MCP route with run-scoped reader proxies. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from '@decimalturn/toml-patch'
import type { ReaderProxyServer } from './mcp-reader-scope.ts'
import { grokSandboxConfig, type RunSandbox } from './sandbox.ts'

/** Rewrite the already-provisioned run home without retaining an undetectable server alias. */
export function scopeGrokReaderMcpHome(
  runDir: string,
  cwd: string,
  sandbox: RunSandbox,
  servers: Record<string, ReaderProxyServer>,
): { header: null; error: null; measure<T>(operation: () => T): T } {
  const target = join(runDir, 'config.toml')
  const parsed = parseToml(readFileSync(target, 'utf8')) as Record<string, unknown>
  const userServers = parsed.mcp_servers as Record<string, unknown> | undefined
  parsed.disabled_mcp_servers = []
  parsed.mcp_servers = {
    ...(userServers?.orch ? { orch: userServers.orch } : {}),
    ...Object.fromEntries(
      Object.entries(servers)
        .filter(([name]) => name !== 'orch' && name !== 'orch-ask')
        .map(([name, server]) => [name, { ...server, enabled: true }]),
    ),
  }
  writeFileSync(target, grokSandboxConfig(stringifyToml(parsed), sandbox), { mode: 0o600 })
  chmodSync(target, 0o600)

  const projectConfig = join(cwd, '.grok', 'config.toml')
  const mcpJson = join(cwd, '.mcp.json')
  const cursorMcpJson = join(cwd, '.cursor', 'mcp.json')
  const controlled = [projectConfig, mcpJson, cursorMcpJson].map(snapshotFile)
  const projectParsed = existsSync(projectConfig)
    ? (parseToml(readFileSync(projectConfig, 'utf8')) as Record<string, unknown>)
    : {}
  projectParsed.disabled_mcp_servers = []
  projectParsed.mcp_servers = Object.fromEntries(
    Object.entries(servers)
      .filter(([name]) => name !== 'orch' && name !== 'orch-ask')
      .map(([name, server]) => [name, { ...server, enabled: true }]),
  )
  replaceFile(projectConfig, stringifyToml(projectParsed), 0o600)
  replaceFile(mcpJson, '{"mcpServers":{}}\n', 0o600)
  replaceFile(cursorMcpJson, '{"mcpServers":{}}\n', 0o600)
  const runtime = controlled.map(({ path }) => snapshotFile(path))

  return {
    header: null,
    error: null,
    measure<T>(operation: () => T): T {
      if (!runtime.every((state) => fileMatches(state))) return operation()
      controlled.forEach(restoreFile)
      try {
        return operation()
      } finally {
        runtime.forEach(restoreFile)
      }
    },
  }
}

type FileState =
  | { path: string; kind: 'missing' }
  | { path: string; kind: 'symlink'; link: string }
  | { path: string; kind: 'file'; content: Buffer; mode: number }

function snapshotFile(path: string): FileState {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return { path, kind: 'symlink', link: readlinkSync(path) }
    return { path, kind: 'file', content: readFileSync(path), mode: stat.mode & 0o777 }
  } catch {
    return { path, kind: 'missing' }
  }
}

function replaceFile(path: string, content: string | Buffer, mode: number): void {
  rmSync(path, { force: true })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
}

function restoreFile(state: FileState): void {
  rmSync(state.path, { force: true })
  if (state.kind === 'missing') {
    const parent = dirname(state.path)
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true })
    } catch {
      // The parent either predates this scope or was already absent.
    }
    return
  }
  mkdirSync(dirname(state.path), { recursive: true })
  if (state.kind === 'symlink') symlinkSync(state.link, state.path)
  else replaceFile(state.path, state.content, state.mode)
}

function fileMatches(expected: FileState): boolean {
  const actual = snapshotFile(expected.path)
  if (actual.kind !== expected.kind) return false
  if (actual.kind === 'missing') return true
  if (actual.kind === 'symlink')
    return actual.link === (expected as Extract<FileState, { kind: 'symlink' }>).link
  const file = expected as Extract<FileState, { kind: 'file' }>
  return actual.mode === file.mode && actual.content.equals(file.content)
}
