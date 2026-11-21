// concern: workflow-step-outcome-floors
/** Validates per-outcome floor overrides independently of catalogue storage. */

import { isFloorKind } from './workflow-floor.ts'

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function outcomeFloorErrors(item: Record<string, unknown>): string[] {
  if (item.outcomeFloors === undefined) return []
  const slug = String(item.slug ?? '')
  if (!object(item.outcomeFloors))
    return [`step "${slug}" outcomeFloors must be an outcome-to-floor-list map`]
  const errors: string[] = []
  const outcomes = new Set(Array.isArray(item.outcomes) ? item.outcomes : [])
  for (const [outcome, floors] of Object.entries(item.outcomeFloors)) {
    if (!outcomes.has(outcome))
      errors.push(`step "${slug}" outcomeFloors key "${outcome}" must be a declared outcome`)
    if (
      !Array.isArray(floors) ||
      floors.length === 0 ||
      new Set(floors).size !== floors.length ||
      floors.some((floor) => typeof floor !== 'string' || !isFloorKind(floor))
    )
      errors.push(
        `step "${slug}" outcomeFloors.${outcome} must be a non-empty unique list of known floor kinds`,
      )
  }
  return errors
}
