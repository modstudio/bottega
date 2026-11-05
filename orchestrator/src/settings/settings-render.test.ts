import { describe, expect, test } from 'bun:test'
import { ownedSettingsEqual, SETTINGS_PARSE_REFUSAL } from './settings.ts'
import {
  diffOwnedSettings,
  parseSettingsFile,
  plainSettingsEnvironment,
  renderOwnedSettingsFile,
} from './settings-render.ts'

const source = `{
  "env": {
    "FOO":"bar"
  },
  "permissions": {
    "allow": ["old"]
  },
  "tui": {
    "compact": true
  }
}
`

describe('renderOwnedSettingsFile', () => {
  test('replaces owned keys and byte-preserves the others in order', () => {
    const rendered = renderOwnedSettingsFile(source, {
      permissions: { allow: ['new'] },
      hooks: { SessionStart: [{ matcher: '*' }] },
    })
    expect(rendered).toContain('"env": {\n    "FOO":"bar"\n  }')
    expect(rendered).toContain('"tui": {\n    "compact": true\n  }')
    expect(rendered).toContain('"permissions": {\n    "allow": [\n      "new"\n    ]\n  }')
    expect(rendered).toContain('"hooks": {')
    expect(rendered).not.toContain('"autoMode"')
    expect(rendered.indexOf('"env"')).toBeLessThan(rendered.indexOf('"permissions"'))
    expect(rendered.indexOf('"permissions"')).toBeLessThan(rendered.indexOf('"tui"'))
    expect(rendered.indexOf('"tui"')).toBeLessThan(rendered.indexOf('"hooks"'))
    expect(JSON.parse(rendered).env).toEqual({ FOO: 'bar' })
  })

  test('refuses unparseable JSON', () => {
    expect(() => parseSettingsFile('{')).toThrow(SETTINGS_PARSE_REFUSAL)
    expect(() => renderOwnedSettingsFile('{', { permissions: {}, hooks: {} })).toThrow(
      SETTINGS_PARSE_REFUSAL,
    )
  })

  test('renders exactly the selected env keys with supplied values', () => {
    const rendered = renderOwnedSettingsFile(
      source,
      { permissions: {}, hooks: {}, envKeys: ['ALPHA'] },
      { ALPHA: 'private-value' },
    )
    expect(JSON.parse(rendered).env).toEqual({ ALPHA: 'private-value' })
    expect(JSON.parse(rendered).env).not.toHaveProperty('FOO')
  })
})

describe('parseSettingsFile', () => {
  test('the parse result type has no path to env', () => {
    const parsed = parseSettingsFile(source)
    expect(parsed).not.toHaveProperty('value')
    expect('env' in parsed).toBe(false)
    expect('env' in parsed.owned).toBe(false)
    type Parsed = ReturnType<typeof parseSettingsFile>
    type Forbidden = Extract<keyof Parsed, 'value' | 'env'>
    const noPath: [Forbidden] extends [never] ? true : false = true
    expect(noPath).toBe(true)
    expect(Object.keys(parsed).sort()).toEqual([
      'close',
      'envKeys',
      'members',
      'open',
      'owned',
      'text',
    ])
    expect(parsed.envKeys).toEqual(['FOO'])
    expect(parsed.members.every((member) => !('name' in member))).toBe(true)
    expect(parsed.owned).toEqual({
      permissions: { allow: ['old'] },
      hooks: {},
      envKeys: [],
    })
  })

  test('reads values only for named plain environment settings', () => {
    const text = JSON.stringify({ env: { PLAIN: 'visible', PRIVATE: 'secret' } })
    const plain = plainSettingsEnvironment(text, ['PLAIN'])
    expect(plain).toEqual({ PLAIN: 'visible' })
    expect(plain).not.toHaveProperty('PRIVATE')
    expect(Object.values(plain)).not.toContain('secret')
  })
})

describe('diffOwnedSettings', () => {
  test('reports added and removed rules and hooks without hook bodies', () => {
    const file = {
      permissions: { allow: ['keep', 'added'], deny: ['gone-from-store'] },
      hooks: { PreToolUse: [{ matcher: 'Bash' }] },
    }
    const store = {
      permissions: { allow: ['keep', 'removed'], deny: [] },
      hooks: { PreToolUse: [{ matcher: 'Edit' }] },
    }
    const drift = diffOwnedSettings(file, store)
    expect(drift.rules.allow.added).toEqual(['added'])
    expect(drift.rules.allow.removed).toEqual(['removed'])
    expect(drift.rules.deny.added).toEqual(['gone-from-store'])
    expect(drift.rules.deny.removed).toEqual([])
    expect(drift.hooks.added).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        path: 'hooks.PreToolUse[0]',
      },
    ])
    expect(drift.hooks.removed).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Edit',
        fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        path: 'hooks.PreToolUse[0]',
      },
    ])
    expect(JSON.stringify(drift)).not.toContain('command')
  })

  test('is empty when lists match including duplicates', () => {
    const owned = {
      permissions: { allow: ['a', 'a'] },
      hooks: {},
    }
    expect(ownedSettingsEqual(owned, owned)).toBe(true)
    expect(diffOwnedSettings(owned, owned).hooks.added).toEqual([])
  })

  test('renders and reports differing auto-mode lists', () => {
    const rendered = renderOwnedSettingsFile(source, {
      permissions: {},
      hooks: {},
      autoMode: { allow: ['$defaults', 'Bash(docker compose *)'] },
    })
    expect(JSON.parse(rendered).autoMode).toEqual({
      allow: ['$defaults', 'Bash(docker compose *)'],
    })
    const drift = diffOwnedSettings(
      { permissions: {}, hooks: {}, autoMode: { allow: ['$defaults', 'local'] } },
      { permissions: {}, hooks: {}, autoMode: { allow: ['$defaults', 'canonical'] } },
    )
    expect(drift.autoMode.allow).toEqual({ added: ['local'], removed: ['canonical'] })
  })

  test('preserves file auto-mode bytes and reports no drift while it is unowned', () => {
    const local = source.replace(
      '  "tui":',
      '  "autoMode": { "allow":["$defaults",  "local"] },\n  "tui":',
    )
    const rendered = renderOwnedSettingsFile(local, { permissions: {}, hooks: {} })
    expect(rendered).toContain('"autoMode": { "allow":["$defaults",  "local"] }')
    const file = parseSettingsFile(local).owned
    const store = { permissions: file.permissions, hooks: file.hooks }
    expect(ownedSettingsEqual(file, store)).toBe(false)
    expect(diffOwnedSettings(file, store).autoMode.allow).toEqual({ added: [], removed: [] })
  })

  test('replaces file auto-mode once canonical settings own it', () => {
    const local = source.replace('  "tui":', '  "autoMode": { "allow":["local"] },\n  "tui":')
    const rendered = renderOwnedSettingsFile(local, {
      permissions: {},
      hooks: {},
      autoMode: { allow: ['canonical'] },
    })
    expect(JSON.parse(rendered).autoMode).toEqual({ allow: ['canonical'] })
    expect(rendered).not.toContain('["local"]')
  })

  test('a defaultMode-only difference is drift', () => {
    const file = { permissions: { allow: ['a'], defaultMode: 'acceptEdits' }, hooks: {} }
    const store = { permissions: { allow: ['a'] }, hooks: {} }
    expect(ownedSettingsEqual(file, store)).toBe(false)
    expect(diffOwnedSettings(file, store).rules.allow.added).toEqual([])
    expect(diffOwnedSettings(file, store).rules.allow.removed).toEqual([])
  })

  test('a file-only additionalDirectories is drift', () => {
    const file = {
      permissions: { allow: ['a'], additionalDirectories: ['src'] },
      hooks: {},
    }
    const store = { permissions: { allow: ['a'] }, hooks: {} }
    expect(ownedSettingsEqual(file, store)).toBe(false)
  })

  test('hooks that differ only in key order are not drift', () => {
    const file = {
      permissions: {},
      hooks: { PreToolUse: [{ matcher: 'Bash', type: 'command' }] },
    }
    const store = {
      permissions: {},
      hooks: { PreToolUse: [{ type: 'command', matcher: 'Bash' }] },
    }
    expect(ownedSettingsEqual(file, store)).toBe(true)
    expect(diffOwnedSettings(file, store).hooks.added).toEqual([])
    expect(diffOwnedSettings(file, store).hooks.removed).toEqual([])
  })
})
