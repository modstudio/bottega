// concern: project-space
/** Owns local routing from a project to its complete cached hosted catalogues. */
import type { Database } from 'bun:sqlite'

const PROJECT_SPACES = 'record_project_spaces'
const ACTIVE_SPACE = 'record_active_space'

function read(local: Database): string | undefined {
  return local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(PROJECT_SPACES)?.value
}

function write(local: Database, value: string): void {
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(PROJECT_SPACES, value)
}

export function rememberProjectSpace(
  local: Database,
  project: string,
  spaceId: string | null,
): void {
  const spaces = cachedProjectSpaces(local)
  spaces[project] = spaceId
  write(local, JSON.stringify(spaces))
}

export function cachedProjectSpaces(local: Database): Record<string, string | null> {
  const stored = read(local)
  if (!stored) return {}
  try {
    return JSON.parse(stored) as Record<string, string | null>
  } catch {
    return {}
  }
}

export function effectiveProjectSpace(local: Database, project: string | null): string | null {
  if (!project) return null
  return cachedProjectSpaces(local)[project] ?? null
}

export function rememberActiveRecordSpace(local: Database, spaceId: string): void {
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(ACTIVE_SPACE, spaceId)
}

export function activeRecordSpace(local: Database): string | null {
  const value = local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(ACTIVE_SPACE)?.value
  return value ?? null
}

/**
 * Chooses the only space from which workflow and step-catalogue reads may resolve.
 * Local lifecycle writes remain NULL-space: record write authority reaches them only on an
 * unbound machine, where this decision also resolves project-less reads to NULL.
 */
export function workflowReadSpace(input: {
  project: string | null
  projectSpace: string | null | undefined
  activeSpace: string | null
  localAuthoritative: boolean
  missingActiveSpaceRefusal: string
  missingProjectRouteRefusal: string
  rejectedProjectRouteRefusal: string
}): { spaceId: string | null } | { refused: string } {
  const routed = input.project ? input.projectSpace : input.activeSpace
  if (routed) return { spaceId: routed }
  if (input.localAuthoritative) return { spaceId: null }
  if (!input.project) return { refused: input.missingActiveSpaceRefusal }
  return {
    refused:
      input.projectSpace === undefined
        ? input.missingProjectRouteRefusal
        : input.rejectedProjectRouteRefusal,
  }
}
