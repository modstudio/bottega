// concern: tracked recipe allocation claims
/** Claims the indexed string and database values of one tracked recipe. */

import type { Database } from 'bun:sqlite'
import { claimDatabaseName, claimString } from '../resources/resource-claims.ts'
import type { ClaimOwner } from '../resources/resource-step-recorder.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import { renderTrackedNamedAllocations } from './tracked-allocation-keys.ts'

export function claimTrackedNamedAllocations(
  database: Database,
  input: {
    identity: ClaimOwner & { projectId: string; claimedAt: string }
    recipe: TrackedRecipe
    staticVars: Record<string, string>
    index: number
  },
): { strings: Record<string, string>; databases: Record<string, string> } {
  const rendered = renderTrackedNamedAllocations(input)
  const strings: Record<string, string> = {}
  for (const allocation of rendered.strings) {
    strings[allocation.name] = claimString(database, {
      ...input.identity,
      ...allocation,
    })
  }
  const databases: Record<string, string> = {}
  for (const allocation of rendered.databases) {
    databases[allocation.name] = claimDatabaseName(database, {
      ...input.identity,
      ...allocation,
    })
  }
  return { strings, databases }
}
