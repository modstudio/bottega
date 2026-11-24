// concern: tracked recipe allocation keys
/** Renders the claimed values that an indexed recipe allocation would use. */

import {
  databaseAllocationKey,
  fillStringAllocationTemplate,
  stringAllocationKey,
} from '../resources/resource-claims.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

export type RenderedTrackedNamedAllocations = {
  strings: { name: string; value: string; templateHasIndex: boolean }[]
  databases: {
    name: string
    engine: string
    value: string
    templateHasIndex: boolean
  }[]
}

export function renderTrackedNamedAllocations(input: {
  recipe: TrackedRecipe
  staticVars: Record<string, string>
  index: number
}): RenderedTrackedNamedAllocations {
  const vars = { ...input.staticVars, index: String(input.index) }
  return {
    strings: Object.entries(input.recipe.allocate?.strings ?? {}).map(([name, template]) => ({
      name,
      value: fillStringAllocationTemplate(name, template, vars),
      templateHasIndex: template.includes('{index}'),
    })),
    databases: Object.entries(input.recipe.allocate?.databases ?? {}).map(([name, allocation]) => ({
      name,
      engine: allocation.engine,
      value: fillStringAllocationTemplate(name, allocation.name, vars),
      templateHasIndex: allocation.name.includes('{index}'),
    })),
  }
}

export function trackedAllocationKeys(input: {
  recipe: TrackedRecipe
  staticVars: Record<string, string>
  projectId: string
  index: number
}): string[] {
  const rendered = renderTrackedNamedAllocations(input)
  return [
    ...rendered.strings
      .filter((allocation) => allocation.templateHasIndex)
      .map((allocation) => stringAllocationKey(input.projectId, allocation.value)),
    ...rendered.databases
      .filter((allocation) => allocation.templateHasIndex)
      .map((allocation) => databaseAllocationKey(allocation.engine, allocation.value)),
  ]
}
