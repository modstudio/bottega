export type CheckExecutionCardinality = { check: string; count: number }

/** Find planned checks that do not have exactly one execution record. */
export function checkExecutionCardinality(
  plannedNames: readonly string[],
  recordNames: readonly string[],
): CheckExecutionCardinality[] {
  const counts = new Map<string, number>()
  for (const name of recordNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  return plannedNames.flatMap((check) => {
    const count = counts.get(check) ?? 0
    return count === 1 ? [] : [{ check, count }]
  })
}
