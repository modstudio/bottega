// concern: settings-machine-permissions
/** Owns operator-only edits to the machine permission overlay. */
import {
  editMachinePermission,
  type MachinePermissionOperation,
} from '../../../shared/machine-config.ts'
import {
  SETTINGS_PERMISSION_LISTS,
  type SettingsPermissionList,
} from '../../../shared/settings-summary.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'

export function editMachineSettingsPermission(
  input: {
    operation: MachinePermissionOperation
    list: string | undefined
    rule: string | undefined
  },
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): { changed: boolean; counts: Record<SettingsPermissionList, number>; message: string } {
  if (!SETTINGS_PERMISSION_LISTS.includes(input.list as SettingsPermissionList))
    throw new Error(
      `refusing settings permission: --list must be ${SETTINGS_PERMISSION_LISTS.join(', ')}`,
    )
  const rule = input.rule?.trim()
  if (!rule) throw new Error('refusing settings permission: --rule is required')
  if (isOrchWorkerProcess(env, pid, inventory))
    throw new Error(
      'refusing machine permission write from an orch worker run; an operator must edit machine permissions',
    )
  const result = editMachinePermission(
    input.operation,
    input.list as SettingsPermissionList,
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
