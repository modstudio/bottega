// concern: machine-identity
/** Knows the durable identity and display name of this machine. Must not know runs or hosted records. */
import { hostname } from 'node:os'
import { db, writeTransaction } from '../database/db.ts'
import { machineIdFromStore } from '../database/machine-identity-store.ts'

export function machineId(): string {
  return machineIdFromStore(db(), writeTransaction)
}

export function machineName(): string {
  return hostname()
}
