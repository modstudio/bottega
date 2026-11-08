// concern: machine-name-options
/** Owns interactive CLI collection of machine names. */
import { hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { storedMachineNamePair } from '../record/machine-identity.ts'
import type { MachineNamePair } from '../record/machine-name.ts'
import { defaultShortName, displayNameRefusal, shortNameRefusal } from '../record/machine-name.ts'

export function resolveRequestedMachineNames(
  shortName: string | undefined,
  displayName: string | undefined,
  storedNames: MachineNamePair | null,
  defaultName: string,
): MachineNamePair | undefined {
  if (shortName === undefined && displayName === undefined && storedNames) return undefined
  const resolvedShortName = shortName ?? storedNames?.shortName ?? defaultName
  return {
    shortName: resolvedShortName,
    displayName: displayName ?? storedNames?.displayName ?? resolvedShortName,
  }
}

export async function requestedMachineNames(options: {
  shortName?: string
  displayName?: string
}): Promise<MachineNamePair | undefined> {
  const fallback = defaultShortName(hostname())
  const storedNames = storedMachineNamePair()
  let shortName = options.shortName
  let displayName = options.displayName
  let resolved = resolveRequestedMachineNames(shortName, displayName, storedNames, fallback)
  if (!resolved) return undefined
  if (process.stdin.isTTY && (!shortName || !displayName)) {
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    if (!shortName)
      shortName =
        (await terminal.question(`Short name [${resolved.shortName}]: `)).trim() ||
        resolved.shortName
    resolved = resolveRequestedMachineNames(shortName, displayName, storedNames, fallback)!
    if (!displayName)
      displayName =
        (await terminal.question(`Display name [${resolved.displayName}]: `)).trim() ||
        resolved.displayName
    terminal.close()
  }
  resolved = resolveRequestedMachineNames(shortName, displayName, storedNames, fallback)!
  const refusal = shortNameRefusal(resolved.shortName) ?? displayNameRefusal(resolved.displayName)
  if (refusal) throw new Error(refusal)
  return resolved
}
