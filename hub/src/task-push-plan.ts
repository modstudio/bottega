export type IdentitySetComparison = {
  both: number
  machineOnly: string[]
  hostedOnly: string[]
  inFlight: string[]
}

/** Classify one table's machine, hosted, and in-flight ids. In-flight is not missing. */
export function compareIdentitySets(
  machineIds: readonly string[],
  hostedIds: readonly string[],
  inFlightIds: ReadonlySet<string>,
): IdentitySetComparison {
  const hosted = new Set(hostedIds)
  const machine = new Set(machineIds)
  let both = 0
  const machineOnly: string[] = []
  const inFlight: string[] = []
  for (const id of machine) {
    if (hosted.has(id)) both++
    else if (inFlightIds.has(id)) inFlight.push(id)
    else machineOnly.push(id)
  }
  return {
    both,
    machineOnly: machineOnly.sort(),
    hostedOnly: hostedIds.filter((id) => !machine.has(id)).sort(),
    inFlight: inFlight.sort(),
  }
}

export function identitySetAgrees(comparison: IdentitySetComparison): boolean {
  return comparison.machineOnly.length === 0 && comparison.hostedOnly.length === 0
}
