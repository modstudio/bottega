// concern: project-space-cache
/** Owns the cached hosted-space route for each local project. */
import type { Database } from 'bun:sqlite'

const PROJECT_SPACES = 'record_project_spaces'

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
