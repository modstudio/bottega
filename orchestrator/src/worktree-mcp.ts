// concern: worktree-mcp
/**
 * Knows isolated worker directories and worker MCP configuration provisioning.
 * Must not know routing, transports, run state, or database writes.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

type McpConfigPreflight = { header: string | null; error: string | null }

/** Put cwd-discovered project MCP config at the address the vendor will inspect. */
export function provisionMcpConfig(worktree: string, checkout: string): McpConfigPreflight {
  const target = join(worktree, '.mcp.json')
  if (existsSync(target)) return { header: null, error: null }
  const source = join(checkout, '.mcp.json')
  if (!existsSync(source)) {
    return {
      header: null,
      error: `missing .mcp.json in worker cwd ${worktree}; registered checkout ${checkout} has no .mcp.json either`,
    }
  }
  const link = relative(dirname(target), source)
  symlinkSync(link, target)
  return { header: `MCP preflight: linked .mcp.json -> ${link}`, error: null }
}

export function prepareWorkerMcpConfig(worktree: string, checkout: string, inherited: boolean) {
  const target = join(worktree, '.mcp.json')
  const expected = relative(dirname(target), join(checkout, '.mcp.json'))
  let link: string | null = null
  if (inherited) {
    try {
      link = lstatSync(target).isSymbolicLink() && readlinkSync(target) === expected
        ? expected
        : null
    } catch { /* the target may not exist until provisioned below */ }
  }
  const config = provisionMcpConfig(worktree, checkout)
  if (config.header !== null) link = readlinkSync(target)
  return {
    ...config,
    measure<T>(measure: () => T): T {
      if (link === null) return measure()
      try {
        if (!lstatSync(target).isSymbolicLink() || readlinkSync(target) !== link) return measure()
      } catch {
        return measure()
      }
      unlinkSync(target)
      try {
        return measure()
      } finally {
        symlinkSync(link, target)
      }
    },
  }
}

/** Create a private working directory for a worker that must not see a repository. */
export function createIsolatedWorkerDirectory(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  mkdirSync(path, { mode: 0o700 })
  return () => rmSync(path, { recursive: true, force: true })
}

