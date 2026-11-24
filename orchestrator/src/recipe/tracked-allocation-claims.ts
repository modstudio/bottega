// concern: tracked recipe allocation claims
/** Claims the indexed string and database values of one tracked recipe. */

import type { Database } from 'bun:sqlite'
import {
  claimDatabaseName,
  claimString,
  fillStringAllocationTemplate,
} from '../resources/resource-claims.ts'
import type { ClaimOwner } from '../resources/resource-step-recorder.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

export function claimTrackedNamedAllocations(
  database: Database,
  input: {
    identity: ClaimOwner & { projectId: string; claimedAt: string }
    recipe: TrackedRecipe
    staticVars: Record<string, string>
    index: number
  },
): { strings: Record<string, string>; databases: Record<string, string> } {
  const vars = { ...input.staticVars, index: String(input.index) }
  const strings: Record<string, string> = {}
  for (const [name, template] of Object.entries(input.recipe.allocate?.strings ?? {})) {
    const value = fillStringAllocationTemplate(name, template, vars)
    strings[name] = claimString(database, {
      ...input.identity,
      name,
      value,
      templateHasIndex: template.includes('{index}'),
    })
  }
  const databases: Record<string, string> = {}
  for (const [name, allocation] of Object.entries(input.recipe.allocate?.databases ?? {})) {
    const value = fillStringAllocationTemplate(name, allocation.name, vars)
    databases[name] = claimDatabaseName(database, {
      ...input.identity,
      name,
      engine: allocation.engine,
      value,
      templateHasIndex: allocation.name.includes('{index}'),
    })
  }
  return { strings, databases }
}
