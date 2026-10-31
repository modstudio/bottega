export type MachineRef = {
  id: string
  shortName: string | null
  displayName: string | null
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
