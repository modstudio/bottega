// concern: settings-permission
/** Pure permission-list edits. Must not know stores, commands, transports, or filesystems. */
import {
  isPlainObject,
  type OwnedSettings,
  type PermissionList,
  permissionLists,
} from './settings.ts'

export type SettingsPermissionOperation = 'add' | 'remove'

export type SettingsPermissionEdit = {
  settings: OwnedSettings
  permissions: Record<PermissionList, string[]>
  changed: boolean
  message?: string
}

export function editSettingsPermission(
  owned: OwnedSettings,
  input: { list: PermissionList; rule: string; operation: SettingsPermissionOperation },
): SettingsPermissionEdit {
  const permissions = permissionLists(owned.permissions)
  const current = permissions[input.list]
  const present = current.includes(input.rule)
  if ((input.operation === 'add' && present) || (input.operation === 'remove' && !present)) {
    return {
      settings: owned,
      permissions,
      changed: false,
      message: input.operation === 'add' ? 'already present' : 'rule is absent',
    }
  }
  const next =
    input.operation === 'add'
      ? [...current, input.rule]
      : current.filter((item) => item !== input.rule)
  const settings = {
    ...owned,
    permissions: {
      ...(isPlainObject(owned.permissions) ? owned.permissions : {}),
      [input.list]: next,
    },
  }
  return { settings, permissions: permissionLists(settings.permissions), changed: true }
}
