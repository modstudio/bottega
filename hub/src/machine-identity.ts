import { storedMachineNames } from '../../shared/machine-config.ts'

export function localMachineNames(): { displayName: string | null } {
  return { displayName: storedMachineNames()?.displayName ?? null }
}
