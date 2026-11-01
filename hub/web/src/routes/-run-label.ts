export function runDisplayLabel(machineLabel: string | null | undefined, id: number | string) {
  return String(machineLabel ?? id)
}
