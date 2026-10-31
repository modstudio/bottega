export function selectSnapshot<T extends { machineId: string; takenAt: string }>(
  items: T[],
  machineId?: string,
) {
  const ordered = [...items].sort((a, b) => b.takenAt.localeCompare(a.takenAt))
  const selected = machineId ? ordered.find((item) => item.machineId === machineId) : ordered[0]
  return selected
    ? {
        selected,
        machines: ordered.map((item) => ({
          id: item.machineId,
          takenAt: item.takenAt,
          machine:
            'machine' in item
              ? (item.machine as {
                  id: string
                  shortName: string | null
                  displayName: string | null
                })
              : { id: item.machineId, shortName: null, displayName: null },
        })),
      }
    : null
}
