import { describe, expect, test } from 'bun:test'
import { AUTO_MODE_LISTS, type OwnedSettings } from './settings.ts'
import { editSettingsAutoMode } from './settings-auto-mode.ts'

describe('editSettingsAutoMode', () => {
  test.each(AUTO_MODE_LISTS)('appends and removes exact rules in %s', (list) => {
    const initial: OwnedSettings = {
      permissions: {},
      hooks: {},
      autoMode: { [list]: ['prefix', 'exact', 'exact suffix', 'exact'] },
    }
    const added = editSettingsAutoMode(initial, { list, rule: 'exact', operation: 'add' })
    expect(added.autoMode[list]).toEqual(['prefix', 'exact', 'exact suffix', 'exact', 'exact'])
    const removed = editSettingsAutoMode(added.settings, {
      list,
      rule: 'exact',
      operation: 'remove',
    })
    expect(removed.autoMode[list]).toEqual(['prefix', 'exact suffix'])
  })
})
