// concern: settings-machine-permissions
/** Owns operator-only edits to the machine permission overlay. */
import {
  editMachinePermission,
  MACHINE_PERMISSION_LISTS,
  type MachinePermissionList,
} from '../../../shared/machine-config.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'

export type MachinePermissionOperation = 'add' | 'remove' | 'drop' | 'undrop'

export function editMachineSettingsPermission(
  input: {
    operation: MachinePermissionOperation
    list: string | undefined
    rule: string | undefined
  },
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): { changed: boolean; counts: Record<MachinePermissionList, number>; message: string } {
  if (!MACHINE_PERMISSION_LISTS.includes(input.list as MachinePermissionList))
    throw new Error(
      `refusing settings permission: --list must be ${MACHINE_PERMISSION_LISTS.join(', ')}`,
    )
  const rule = input.rule?.trim()
  if (!rule) throw new Error('refusing settings permission: --rule is required')
  if (isOrchWorkerProcess(env, pid, inventory))
    throw new Error(
      'refusing machine permission write from an orch worker run; an operator must edit machine permissions',
    )
  const result = editMachinePermission(
    input.operation,
    input.list as MachinePermissionList,
    rule,
    env,
  )
  const target = input.operation === 'drop' || input.operation === 'undrop' ? 'drop' : 'additions'
  return {
    changed: result.changed,
    counts: {
      allow: result.overlay[target].allow.length,
      ask: result.overlay[target].ask.length,
      deny: result.overlay[target].deny.length,
    },
    message: result.changed ? 'updated machine permissions' : 'machine permissions already current',
  }
}
