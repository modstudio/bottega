// concern: setup MCP configuration migration
/** Finds and rewrites legacy MCP identities in setup-owned JSON configuration. */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { type McpConfigMigration, migrateMcpConfig } from './setup-mcp-config.ts'
export type McpConfigMigrationNotice = { path: string; error: string }
type Candidate = { path: string; projectPath: string | null }

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function projectBoundaryError(candidate: Candidate): string | null {
  if (!candidate.projectPath) return null
  try {
    const root = realpathSync(candidate.projectPath)
    const target = realpathSync(candidate.path)
    return isInside(root, target)
      ? null
      : `resolved path ${target} is outside project checkout ${root}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function captureMcpConfigMigrations(
  home: string,
  projectPaths: readonly string[],
): { migrations: McpConfigMigration[]; notices: McpConfigMigrationNotice[] } {
  const candidates = [
    { path: join(home, '.claude.json'), projectPath: null },
    ...projectPaths.flatMap((projectPath) =>
      ['.mcp.json', join('.claude', 'settings.json'), join('.claude', 'settings.local.json')].map(
        (suffix) => ({ path: join(projectPath, suffix), projectPath }),
      ),
    ),
  ]
  const migrations: McpConfigMigration[] = []
  const notices: McpConfigMigrationNotice[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    const boundaryError = projectBoundaryError(candidate)
    if (boundaryError) {
      notices.push({ path: candidate.path, error: boundaryError })
      continue
    }
    try {
      const before = readFileSync(candidate.path, 'utf8')
      const result = migrateMcpConfig(before)
      if (result.text !== before) migrations.push({ path: candidate.path, summary: result.summary })
    } catch (error) {
      notices.push({
        path: candidate.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { migrations, notices }
}
