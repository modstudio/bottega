export type NulNameStatusEntry = {
  status: string
  path: string
  previousPath: string | null
}

/** Add Git's NUL-output flag without moving a pathspec separator. */
export function nulPathListArgs(args: readonly string[]): string[] {
  const result = [...args]
  if (result.includes('-z')) return result
  const separator = result.indexOf('--')
  result.splice(separator === -1 ? result.length : separator, 0, '-z')
  return result
}

/** Split a Git NUL-delimited path list without changing path bytes represented as text. */
export function splitNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter((field) => field !== '')
}

/** Pair statuses and paths from `git --name-status -z`. */
export function splitNulNameStatus(stdout: string): NulNameStatusEntry[] {
  const fields = splitNulPaths(stdout)
  const entries: NulNameStatusEntry[] = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]!
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++]
      if (previousPath === undefined) {
        throw new Error(`git name-status entry ${status} is missing previousPath`)
      }
      const path = fields[index++]
      if (path === undefined) throw new Error(`git name-status entry ${status} is missing path`)
      entries.push({ status, path, previousPath })
      continue
    }
    const path = fields[index++]
    if (path === undefined) throw new Error(`git name-status entry ${status} is missing path`)
    entries.push({ status, path, previousPath: null })
  }
  return entries
}
