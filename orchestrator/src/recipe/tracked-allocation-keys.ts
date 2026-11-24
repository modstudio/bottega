// concern: tracked recipe allocation keys
/** Renders the claimed values that an indexed recipe allocation would use. */

import { fillStringAllocationTemplate } from '../resources/resource-claims.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

export function trackedAllocationKeys(input: {
  recipe: TrackedRecipe
  staticVars: Record<string, string>
  projectId: string
  index: number
}): string[] {
  const vars = { ...input.staticVars, index: String(input.index) }
  const keys: string[] = []
  for (const [name, template] of Object.entries(input.recipe.allocate?.strings ?? {})) {
    if (!template.includes('{index}')) continue
    const value = fillStringAllocationTemplate(name, template, vars)
    keys.push(`string:${input.projectId}:${value}`)
  }
  for (const [name, allocation] of Object.entries(input.recipe.allocate?.databases ?? {})) {
    if (!allocation.name.includes('{index}')) continue
    const value = fillStringAllocationTemplate(name, allocation.name, vars)
    keys.push(`${allocation.engine}:${value}`)
  }
  return keys
}
