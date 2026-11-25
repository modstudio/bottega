// concern: note slim-list filter semantics
/** Owns special-filter state normalization for slim note lists. */

type SpecialSlimListFilters = {
  promotedTo?: string
  reference?: string
  stale?: boolean
  actionable?: boolean
}

export type SpecialSlimListFilterConflict = {
  kind: 'conflict'
  special: 'promotedTo' | 'reference'
  state: 'stale' | 'actionable'
}

export function normalizeSpecialSlimListFilters(
  filters: SpecialSlimListFilters,
): { kind: 'filters'; filters: SpecialSlimListFilters } | SpecialSlimListFilterConflict {
  const special = filters.promotedTo ? 'promotedTo' : filters.reference ? 'reference' : null
  const state = filters.stale ? 'stale' : filters.actionable ? 'actionable' : null
  if (special && state) return { kind: 'conflict', special, state }
  return {
    kind: 'filters',
    filters: special ? { ...filters, stale: undefined, actionable: undefined } : filters,
  }
}
