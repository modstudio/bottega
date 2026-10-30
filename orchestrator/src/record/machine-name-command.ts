// concern: machine-name-command
/** Applies machine rename and retirement after command-edge validation. */
import { writeMachineNames } from '../../../shared/machine-config.ts'
import { displayNameRefusal, shortNameRefusal } from '../../../shared/machine-name.ts'
import { machineId, machineNames } from './machine-identity.ts'
import { recordApiClient } from './record-api-client.ts'

export async function renameMachine(input: {
  shortName?: string
  displayName?: string
}): Promise<void> {
  if (!input.shortName && !input.displayName)
    throw new Error('machine rename requires --short-name or --display-name')
  const current = machineNames()
  const names = {
    shortName: input.shortName ?? current.shortName,
    displayName: input.displayName ?? current.displayName,
  }
  const refusal = shortNameRefusal(names.shortName) ?? displayNameRefusal(names.displayName)
  if (refusal) throw new Error(refusal)
  const rename = recordApiClient().renameMachine
  if (!rename) throw new Error('hosted record does not support machine rename')
  await rename({ machineId: machineId(), ...names })
  writeMachineNames(names)
}

export async function retireMachine(shortName: string): Promise<string> {
  const refusal = shortNameRefusal(shortName)
  if (refusal) throw new Error(refusal)
  const retire = recordApiClient().retireMachine
  if (!retire) throw new Error('hosted record does not support machine retirement')
  return (await retire(shortName)).machineId
}
