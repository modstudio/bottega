export type MachineRef = {
  id: string
  shortName: string | null
  displayName: string | null
}

export function crossMachineLabel(
  kind: 'run' | 'question',
  number: number,
  machine: Pick<MachineRef, 'id' | 'shortName'>,
): string {
  const machineName = machine.shortName ?? machine.id.slice(0, 8)
  return `${machineName}/${kind === 'question' ? 'q' : ''}${number}`
}
