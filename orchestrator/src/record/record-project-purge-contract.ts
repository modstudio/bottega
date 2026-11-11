// concern: record-project-purge-contract
/** Stable hosted project-purge response shape. */
export type RecordProjectPurgeResult = {
  nothingToRemove: boolean
  tables: Array<{ table: string; count: number }>
  project: number
}
