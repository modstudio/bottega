// concern: database resource identity validation
/** Validates and quotes database identities without reading state or executing clients. */

export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb' | 'sqlite'

export function relativeDatabasePath(path: string): boolean {
  return Boolean(
    path.trim() &&
      !/^[\\/]/.test(path) &&
      !/^[A-Za-z]:[\\/]/.test(path) &&
      !path.split(/[\\/]+/).includes('..'),
  )
}

export function databaseNameProblem(engine: DatabaseEngine, name: string): string | null {
  if (!name || name.includes('\0'))
    return `${engine} database name must be non-empty and contain no NUL`
  if (engine === 'postgres' && Buffer.byteLength(name, 'utf8') > 63)
    return 'postgres database name must be at most 63 UTF-8 bytes'
  if ((engine === 'mysql' || engine === 'mariadb') && [...name].length > 64)
    return `${engine} database name must be at most 64 characters`
  if ((engine === 'mysql' || engine === 'mariadb') && /[\\/.]/.test(name))
    return `${engine} database name must not contain slash, backslash, or dot`
  if (engine === 'sqlite' && !relativeDatabasePath(name))
    return 'sqlite database name must be a path relative to the tree with no .. segment'
  return null
}

export function quotedDatabaseName(engine: DatabaseEngine, name: string): string {
  const problem = databaseNameProblem(engine, name)
  if (problem) throw new Error(problem)
  if (engine === 'sqlite') return name
  return engine === 'postgres'
    ? `"${name.replaceAll('"', '""')}"`
    : `\`${name.replaceAll('`', '``')}\``
}
