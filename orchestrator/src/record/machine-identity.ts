// concern: machine-identity
/** Knows the durable identity and display name of this machine. Must not know runs or hosted records. */
import { hostname } from 'node:os'
import { storedMachineId, storedMachineNames } from '../../../shared/machine-config.ts'
import { type MachineNamePair, resolveMachineDisplayName } from '../../../shared/machine-label.ts'
import { defaultShortName } from './machine-name.ts'

export function machineId(): string {
  const id = storedMachineId()
  if (!id)
    throw new Error(
      'machine identity is not established; open the writable orchestrator store before enqueueing evidence',
    )
  return id
}

export function storedMachineNamePair(): MachineNamePair | null {
  const stored = storedMachineNames()
  return stored
    ? { shortName: stored.shortName, displayName: resolveMachineDisplayName(stored) }
    : null
}

export function machineNames(): { shortName: string; displayName: string } {
  const stored = storedMachineNamePair()
  if (stored) return stored
  const shortName = defaultShortName(hostname())
  return { shortName, displayName: shortName }
}
