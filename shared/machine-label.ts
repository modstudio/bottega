export type MachineRef = {
  id: string
  shortName: string | null
  displayName: string | null
}

export type MachineNamePair<Value extends string | null = string> = {
  shortName: Value
  displayName: Value
}

export function resolveMachineDisplayName(names: {
  shortName: string
  displayName: string | null
}): string
export function resolveMachineDisplayName(names: MachineNamePair<string | null>): string | null
export function resolveMachineDisplayName(names: MachineNamePair<string | null>): string | null {
  return names.displayName ?? names.shortName
}

const UNNAMED_MACHINE_PREFIX = /^[0-9a-f]{8}$/

export function isUnnamedMachinePrefix(name: string): boolean {
  return UNNAMED_MACHINE_PREFIX.test(name)
}

export function crossMachineLabel(
  kind: 'run' | 'question',
  number: number,
  machine: Pick<MachineRef, 'id' | 'shortName'>,
): string {
  const machineName = machine.shortName ?? machine.id.slice(0, 8)
  return `${machineName}/${kind === 'question' ? 'q' : ''}${number}`
}
