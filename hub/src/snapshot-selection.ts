import type { MachineRef } from '../../shared/machine-label.ts'

export function selectSnapshot<
  T extends { machineId: string; takenAt: string; machine: MachineRef },
>(items: T[], machineId?: string) {
  const ordered = [...items].sort((a, b) => b.takenAt.localeCompare(a.takenAt))
  const selected = machineId ? ordered.find((item) => item.machineId === machineId) : ordered[0]
  return selected
    ? {
        selected,
        machines: ordered.map((item) => ({
          id: item.machineId,
          takenAt: item.takenAt,
          machine: item.machine,
        })),
      }
    : null
}
