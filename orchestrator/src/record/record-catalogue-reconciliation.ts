// concern: record-catalogue-reconciliation
/** Decides whether a complete imported catalogue history may replace hosted history. */
export type CatalogueVersionMetadata = {
  id: string
  author: string
}

export type CatalogueReconciliation =
  | { action: 'unchanged'; outcome: null }
  | { action: 'replace-seed'; outcome: 'replaced seeded built-in' }
  | {
      action: 'keep-hosted'
      outcome: 'kept hosted history; local history not imported'
    }

/** Only identity and authorship decide reconciliation; production status deliberately does not. */
export function reconcileCatalogueHistory(
  imported: readonly CatalogueVersionMetadata[],
  hosted: readonly CatalogueVersionMetadata[],
  seedAuthor: string,
): CatalogueReconciliation {
  if (!hosted.length) return { action: 'unchanged', outcome: null }
  const hostedIds = new Set(hosted.map((version) => version.id))
  if (imported.every((version) => hostedIds.has(version.id)))
    return { action: 'unchanged', outcome: null }
  if (hosted.some((version) => version.author !== seedAuthor))
    return {
      action: 'keep-hosted',
      outcome: 'kept hosted history; local history not imported',
    }
  return { action: 'replace-seed', outcome: 'replaced seeded built-in' }
}
