// concern: settings-auto-mode
/** Pure auto-mode classifier-list edits. Must not know stores, commands, transports, or filesystems. */
import { type AutoModeList, autoModeLists, type OwnedSettings } from './settings.ts'

export type SettingsAutoModeOperation = 'add' | 'remove'

export type SettingsAutoModeEdit = {
  settings: OwnedSettings
  autoMode: Record<AutoModeList, string[]>
  changed: boolean
  message?: string
}

export function editSettingsAutoMode(
  owned: OwnedSettings,
  input: { list: AutoModeList; rule: string; operation: SettingsAutoModeOperation },
): SettingsAutoModeEdit {
  const autoMode = autoModeLists(owned.autoMode)
  const current = autoMode[input.list]
  if (input.operation === 'remove' && !current.includes(input.rule)) {
    return { settings: owned, autoMode, changed: false, message: 'rule is absent' }
  }
  const next =
    input.operation === 'add'
      ? [...current, input.rule]
      : current.filter((item) => item !== input.rule)
  const settings = { ...owned, autoMode: { ...(owned.autoMode ?? {}), [input.list]: next } }
  return { settings, autoMode: autoModeLists(settings.autoMode), changed: true }
}
