import type { MachineRef } from '../../../shared/machine-label.ts'

export function recordMachine(row: Record<string, unknown>): MachineRef {
  return {
    id: String(row.machine_id),
    shortName: row.machine_short_name == null ? null : String(row.machine_short_name),
    displayName: row.machine_display_name == null ? null : String(row.machine_display_name),
  }
}
