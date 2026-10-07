// concern: declared database connection values
/** Reads one declared connection at use time and rewrites its URL path without exposing the value. */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export function readConnectionValue(
  projectRoot: string,
  connection: { key: string; file: string },
): { ok: true; value: string } | { ok: false; detail: string } {
  const file = `${projectRoot}/${connection.file}`
  let values: Record<string, string | undefined>
  try {
    values = parseEnv(readFileSync(file, 'utf8'))
  } catch {
    return {
      ok: false,
      detail: `could not read database connection key ${connection.key} from ${connection.file}; add the key to that main-checkout env file`,
    }
  }
  if (!values[connection.key]) {
    return {
      ok: false,
      detail: `database connection key ${connection.key} is missing from ${connection.file}; add it to that main-checkout env file`,
    }
  }
  return { ok: true, value: values[connection.key]! }
}

export function parseConnectionUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error('connection value is not a valid URL')
  }
}

export function connectionUrlForAllocatedDatabase(
  value: string,
  databaseName: string,
  engine: string,
  treeLabel: string,
): string {
  const url = parseConnectionUrl(value)
  url.pathname = `/${encodeURIComponent(databaseName)}`
  if (engine === 'postgres') url.searchParams.set('application_name', `orch-tree-${treeLabel}`)
  return url.href
}
