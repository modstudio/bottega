// concern: record-catalogue-import
/** Chooses whether an imported workflow history may replace its hosted counterpart. */

export type CatalogueVersionMetadata = {
  id: string
  n: number
  author: string
  status: string
}

export type CatalogueReconciliation =
  | { action: 'unchanged'; outcome: null }
  | { action: 'replace-seed'; outcome: 'replaced seeded built-in' }
  | {
      action: 'keep-hosted'
      outcome: 'kept hosted history; local history not imported'
    }

export function reconcileCatalogueHistory(
  imported: readonly CatalogueVersionMetadata[],
  hosted: readonly CatalogueVersionMetadata[],
  seedAuthor: string,
): CatalogueReconciliation {
  const production = imported.some((version) => version.status === 'production')
  if (!production || !hosted.some((version) => version.status === 'production'))
    return { action: 'unchanged', outcome: null }
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
