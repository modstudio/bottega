import {
  installTaskReader,
  type TaskLookupRow,
  type TaskReadPort,
} from '../../src/workflow/task-read-port.ts'

/** Install list-only task reads for a test and return a restoration closure. */
export function installTaskListReaders(
  readers: Pick<TaskReadPort, 'list' | 'listLocal'>,
): () => void {
  const previous = installTaskReader({
    ...readers,
    lookup: async () => [],
    duplicates: async () => [],
    show: async () => {
      throw new Error('task-list fixture does not show tasks')
    },
    documents: async () => [],
    document: async () => {
      throw new Error('task-list fixture does not read task documents')
    },
  })
  return () => {
    installTaskReader(previous)
  }
}

/** Install the smallest task read model needed by cross-surface hook-path fixtures. */
export function installTaskRows(rows: readonly TaskLookupRow[] | null): void {
  if (rows === null) {
    installTaskReader(undefined)
    return
  }
  installTaskReader({
    listLocal: async () => [],
    list: async ({ project, status } = {}) =>
      rows
        .filter(
          (row) =>
            (!project || row.project === project) && (!status || row.status_category === status),
        )
        .map((row) => ({ ...row, source: 'fixture', body: null })),
    lookup: async (project, keys) =>
      rows.filter((row) => row.project === project && keys.includes(row.key)),
    duplicates: async () => [],
    show: async () => {
      throw new Error('task-row fixture does not show tasks')
    },
    documents: async () => [],
    document: async () => {
      throw new Error('task-row fixture does not read task documents')
    },
  })
}
