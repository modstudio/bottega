// concern: machine-name-options
/** Owns interactive CLI collection of machine names. */
import { hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { defaultShortName, displayNameRefusal, shortNameRefusal } from '../record/machine-name.ts'

export async function requestedMachineNames(options: { shortName?: string; displayName?: string }) {
  const fallback = defaultShortName(hostname())
  let shortName = options.shortName
  let displayName = options.displayName
  if (process.stdin.isTTY && (!shortName || !displayName)) {
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    if (!shortName)
      shortName = (await terminal.question(`Short name [${fallback}]: `)).trim() || fallback
    if (!displayName)
      displayName = (await terminal.question(`Display name [${shortName}]: `)).trim() || shortName
    terminal.close()
  }
  shortName ??= fallback
  displayName ??= shortName
  const refusal = shortNameRefusal(shortName) ?? displayNameRefusal(displayName)
  if (refusal) throw new Error(refusal)
  return { shortName, displayName }
}
