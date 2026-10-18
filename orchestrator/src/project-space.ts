// concern: project-space
/** Owns local routing from a project to its complete cached hosted catalogues. */
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

export function rememberProjectSpaces(
  local: Database,
  spaces: ReadonlyMap<string, string | null>,
): void {
  write(local, JSON.stringify(Object.fromEntries(spaces)))
}

export function rememberProjectSpace(
  local: Database,
  project: string,
  spaceId: string | null,
): void {
  let spaces: Record<string, string | null> = {}
  const stored = read(local)
  try {
    if (stored) spaces = JSON.parse(stored) as Record<string, string | null>
  } catch {
    spaces = {}
  }
  spaces[project] = spaceId
  write(local, JSON.stringify(spaces))
}

export function effectiveProjectSpace(local: Database, project: string | null): string | null {
  if (!project) return null
  const stored = read(local)
  if (!stored) return null
  try {
    const spaces = JSON.parse(stored) as Record<string, unknown>
    return typeof spaces[project] === 'string' ? spaces[project] : null
  } catch {
    return null
  }
}
