// concern: tracked recipe persisted execution types

import type { DatabaseOwnership } from './database-provision.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

export type RecipeSnapshot = {
  source: { path: string; commit: string }
  recipe: TrackedRecipe
  allocations?: RecipeAllocations
  databaseOwnership?: DatabaseOwnership
  composeOwnership?: boolean
}

export type RecipeAllocations = {
  index: number
  ports: Record<string, number>
  databases: Record<string, string>
  strings: Record<string, string>
}

export type AllocationAttempt = { allocations: RecipeAllocations; insertedClaimIds: string[] }
