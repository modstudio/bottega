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

/** How Bottega's own database clients identify themselves to the server. */
export const ADMIN_APPLICATION_NAME = 'orch-admin'

const TREE_APPLICATION_NAME_PREFIX = 'orch-tree-'

/** The application name every connection from one tree carries. */
export function treeApplicationName(treeLabel: string): string {
  return `${TREE_APPLICATION_NAME_PREFIX}${treeLabel}`
}

export function isTreeApplicationName(applicationName: string): boolean {
  return applicationName.startsWith(TREE_APPLICATION_NAME_PREFIX)
}

export function connectionUrlForAllocatedDatabase(
  value: string,
  databaseName: string,
  engine: string,
  treeLabel: string,
): string {
  const url = parseConnectionUrl(value)
  url.pathname = `/${encodeURIComponent(databaseName)}`
  if (engine === 'postgres')
    url.searchParams.set('application_name', treeApplicationName(treeLabel))
  return url.href
}
