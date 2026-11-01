import { storedMachineNames } from '../../shared/machine-config.ts'

export function localMachineDisplayName(): { displayName: string | null } {
  const names = storedMachineNames()
  return { displayName: names?.displayName ?? names?.shortName ?? null }
}
