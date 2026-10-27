/** Decides the source-file list for a document command write. */

export type DocSourceFileUpdate = {
  given: readonly string[]
  replace: boolean
}

export type DocSourceFileUpdateMode = 'add' | 'replace' | 'clear'

export function docSourceFileUpdateMode(update: DocSourceFileUpdate): DocSourceFileUpdateMode {
  if (!update.replace) return 'add'
  return update.given.length === 0 ? 'clear' : 'replace'
}

export function docSourceFileExpectedRevision(
  updateMode: DocSourceFileUpdateMode,
  priorRevision: string | undefined,
  operatorExpectedRevision: string | undefined,
): string | undefined {
  if (operatorExpectedRevision !== undefined) return operatorExpectedRevision
  return updateMode === 'add' ? priorRevision : undefined
}

export function mergeDocSourceFiles(
  existing: readonly string[],
  given: readonly string[],
  replace: boolean,
): string[] {
  return [...new Set(replace ? given : [...existing, ...given])]
}
