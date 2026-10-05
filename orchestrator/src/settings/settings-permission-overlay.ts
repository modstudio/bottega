// concern: settings-permission-overlay
/** Purely merges hosted permission rules with one machine overlay. */
import type {
  MachinePermissionList,
  MachinePermissionOverlay,
} from '../../../shared/machine-config.ts'
import { isPlainObject, type OwnedSettings, PERMISSION_LISTS, permissionLists } from './settings.ts'

export type UnmatchedMachineDrop = { list: MachinePermissionList; rule: string }

export function mergeMachinePermissionOverlay(
  hosted: OwnedSettings,
  overlay: MachinePermissionOverlay,
): { settings: OwnedSettings; unmatchedDrops: UnmatchedMachineDrop[] } {
  const hostedLists = permissionLists(hosted.permissions)
  const permissions = isPlainObject(hosted.permissions) ? { ...hosted.permissions } : {}
  const unmatchedDrops: UnmatchedMachineDrop[] = []
  for (const list of PERMISSION_LISTS) {
    const dropped = new Set(overlay.drop[list])
    for (const rule of overlay.drop[list]) {
      if (!hostedLists[list].includes(rule)) unmatchedDrops.push({ list, rule })
    }
    const merged = [
      ...new Set([
        ...hostedLists[list].filter((rule) => !dropped.has(rule)),
        ...overlay.additions[list],
      ]),
    ]
    if (Object.hasOwn(permissions, list) || merged.length > 0) permissions[list] = merged
    else delete permissions[list]
  }
  return { settings: { ...hosted, permissions }, unmatchedDrops }
}
