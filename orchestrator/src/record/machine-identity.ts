// concern: machine-identity
/** Knows the durable identity and display name of this machine. Must not know runs or hosted records. */
import { hostname } from 'node:os'
import { storedMachineId, storedMachineNames } from '../../../shared/machine-config.ts'
import { defaultShortName } from '../../../shared/machine-name.ts'

export function machineId(): string {
  const id = storedMachineId()
  if (!id)
    throw new Error(
      'machine identity is not established; open the writable orchestrator store before enqueueing evidence',
    )
  return id
}

export function machineNames(): { shortName: string; displayName: string } {
  const stored = storedMachineNames()
  if (stored) return stored
  const shortName = defaultShortName(hostname())
  return { shortName, displayName: shortName }
}
