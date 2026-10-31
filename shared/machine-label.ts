export function crossMachineLabel(
  kind: 'run' | 'question',
  number: number,
  machine: { id: string; shortName: string | null },
): string {
  const machineName = machine.shortName ?? machine.id.slice(0, 8)
  return `${machineName}/${kind === 'question' ? 'q' : ''}${number}`
}
