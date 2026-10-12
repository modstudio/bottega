// concern: machine-identity
/** Knows the durable identity and display name of this machine. Must not know runs or hosted records. */
import { hostname } from 'node:os'
import { machineId as sharedMachineId } from '../../../shared/machine-config.ts'

export function machineId(): string {
  return sharedMachineId()
}

export function machineName(): string {
  return hostname()
}
