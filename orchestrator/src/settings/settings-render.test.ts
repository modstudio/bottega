import { describe, expect, test } from 'bun:test'
import { ownedSettingsEqual, SETTINGS_PARSE_REFUSAL } from './settings.ts'
import { diffOwnedSettings, parseSettingsFile, renderOwnedSettingsFile } from './settings-render.ts'

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
    expect(Object.keys(parsed).sort()).toEqual(['close', 'members', 'open', 'owned', 'text'])
    expect(parsed.members.every((member) => !('name' in member))).toBe(true)
    expect(parsed.owned).toEqual({ permissions: { allow: ['old'] }, hooks: {} })
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
