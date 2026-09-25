import { describe, expect, test } from 'bun:test'
import {
  containsSecretShaped,
  extractOwnedSettings,
  ownedSettingsEqual,
  permissionLists,
  refuseSettingsBody,
  SETTINGS_PARSE_REFUSAL,
  serializeOwnedSettings,
  validateOwnedSettingsBody,
} from './settings.ts'

const extra = {
  env: { SECRET: 'do-not-store' },
  enabledPlugins: { a: true },
  permissions: { allow: ['Bash(orch result *)'], deny: ['Bash(rm *)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash' }] },
  tui: { theme: 'dark' },
}

describe('extractOwnedSettings', () => {
  test('keeps only permissions and hooks', () => {
    expect(extractOwnedSettings(extra)).toEqual({
      permissions: extra.permissions,
      hooks: extra.hooks,
      envKeys: [],
    })
  })

  test('fills missing owned keys with empty objects', () => {
    expect(extractOwnedSettings({ env: { A: '1' } })).toEqual({
      permissions: {},
      hooks: {},
      envKeys: [],
    })
  })

  test('refuses a non-object', () => {
    expect(() => extractOwnedSettings([])).toThrow(SETTINGS_PARSE_REFUSAL)
    expect(() => extractOwnedSettings(JSON.parse('[]'))).toThrow(SETTINGS_PARSE_REFUSAL)
  })
})

describe('validateOwnedSettingsBody', () => {
  test('refuses unknown top-level keys', () => {
    expect(() => validateOwnedSettingsBody(JSON.stringify(extra))).toThrow(/unknown or missing/)
  })

  test('accepts exactly permissions and hooks', () => {
    const owned = extractOwnedSettings(extra)
    expect(validateOwnedSettingsBody(serializeOwnedSettings(owned))).toEqual(owned)
  })

  test('accepts only sorted env names and never env values', () => {
    expect(
      validateOwnedSettingsBody(
        serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: ['ALPHA', 'BETA_2'] }),
      ).envKeys,
    ).toEqual(['ALPHA', 'BETA_2'])
    expect(() =>
      validateOwnedSettingsBody(
        JSON.stringify({ permissions: {}, hooks: {}, envKeys: ['BETA', 'ALPHA'] }),
      ),
    ).toThrow(/unknown or missing/)
    expect(() =>
      validateOwnedSettingsBody(
        JSON.stringify({ permissions: {}, hooks: {}, envKeys: { ALPHA: 'secret' } }),
      ),
    ).toThrow(/unknown or missing/)
  })

  test('refuseSettingsBody ignores other scopes', () => {
    expect(refuseSettingsBody('canon', 'not json')).toBeNull()
    expect(refuseSettingsBody('settings', '{"env":1}')).toContain('unknown or missing')
  })
})

test('permissionLists reads allow, ask, and deny strings', () => {
  expect(
    permissionLists({
      allow: ['a', 1, 'b'],
      ask: ['c'],
      deny: ['d'],
      extra: ['no'],
    }),
  ).toEqual({ allow: ['a', 'b'], ask: ['c'], deny: ['d'] })
})

test('ownedSettingsEqual ignores object key order', () => {
  expect(
    ownedSettingsEqual(
      { permissions: { deny: ['x'], allow: ['a'] }, hooks: { a: 1, b: 2 } },
      { permissions: { allow: ['a'], deny: ['x'] }, hooks: { b: 2, a: 1 } },
    ),
  ).toBe(true)
})

function jwtSentinel() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url')
  const signature = Buffer.from('x'.repeat(32)).toString('base64url')
  return [header, payload, signature].join('.')
}

describe('containsSecretShaped', () => {
  const cases: Array<{ name: string; value: () => string; refuse: boolean }> = [
    {
      name: 'URL userinfo',
      value: () => ['https://user', ':pass@', 'host.example'].join(''),
      refuse: true,
    },
    { name: 'JWT', value: jwtSentinel, refuse: true },
    {
      name: 'PEM private key',
      value: () => ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      refuse: true,
    },
    {
      name: 'PEM RSA private key',
      value: () => ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
      refuse: true,
    },
    {
      name: 'base64 of 20 bytes',
      value: () => Buffer.from('a'.repeat(20)).toString('base64'),
      refuse: true,
    },
    {
      name: 'AWS key prefix',
      value: () => ['AKIA', 'TESTKEYEXAMPLE0000'].join(''),
      refuse: true,
    },
    {
      name: 'hook command path',
      value: () => 'bun --no-env-file "$CLAUDE_PROJECT_DIR/orchestrator/hooks/canon-edit-guard.ts"',
      refuse: false,
    },
    { name: 'permission rule', value: () => 'Bash(./bin/orch result *)', refuse: false },
    {
      name: 'path with long words',
      value: () => 'orchestrator/hooks/canon-edit-guard.ts',
      refuse: false,
    },
  ]

  test.each(cases)('$name', ({ value, refuse }) => {
    const text = value()
    expect(containsSecretShaped(text)).toBe(refuse)
    const body = serializeOwnedSettings({ permissions: { allow: [text] }, hooks: {} })
    const refusal = refuseSettingsBody('settings', body)
    if (refuse) {
      expect(refusal).toContain('permissions.allow[0]')
      expect(refusal).not.toContain(text)
    } else {
      expect(refusal).toBeNull()
    }
  })
})

describe('secretShapedSettingsRefusal', () => {
  test('refuses a sentinel hook command without quoting it', () => {
    const credential = ['Bearer ', 'z'.repeat(24)].join('')
    const command = `curl -H "Authorization: ${credential}" https://example.invalid`
    const refusal = refuseSettingsBody(
      'settings',
      serializeOwnedSettings({
        permissions: {},
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
        },
      }),
    )
    expect(refusal).toContain('hooks.PreToolUse[0].hooks[0].command')
    expect(refusal).toContain('env variable supplied from the secrets file')
    expect(refusal).not.toContain(credential)
    expect(refusal).not.toContain(command)
  })

  test('refuses a sentinel permission rule without quoting it', () => {
    const credential = ['ghp_', 'testtoken', '0'.repeat(28)].join('')
    const rule = `Bash(${credential})`
    const refusal = refuseSettingsBody(
      'settings',
      serializeOwnedSettings({ permissions: { allow: [rule] }, hooks: {} }),
    )
    expect(refusal).toContain('permissions.allow[0]')
    expect(refusal).not.toContain(credential)
  })

  test('accepts a clean hook command', () => {
    expect(
      refuseSettingsBody(
        'settings',
        serializeOwnedSettings({
          permissions: { allow: ['Bash(orch result *)'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command:
                      'bun --no-env-file "$CLAUDE_PROJECT_DIR/orchestrator/hooks/canon-edit-guard.ts"',
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toBeNull()
  })
})
