import { storedMachineNames } from '../../shared/machine-config.ts'
import { resolveMachineDisplayName } from '../../shared/machine-label.ts'

export function localMachineDisplayName(): { displayName: string | null } {
  const names = storedMachineNames()
  return { displayName: names ? resolveMachineDisplayName(names) : null }
}
