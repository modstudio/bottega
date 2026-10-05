import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from './config-directory.ts'
import {
  editMachinePermission,
  editMachinePermissionTable,
  MACHINE_CONFIG,
  readMachinePermissions,
  readMachineValue,
  resolveMachineValue,
  setMachineAutonomy,
} from './machine-config.ts'

const path = '/config/platform/machine.toml'
const silent = () => {}
const freshWarnings = () => new Set<string>()

describe('machine config resolution', () => {
  test('resolves canonical environment over legacy, file, and default', () => {
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { ORCH_MODEL_HOST_URL: 'canonical', ORCH_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe('canonical')
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { ORCH_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe('legacy')
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        {},
        { hub: { port: 9000 } },
        'hub.port',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe(9000)
    expect(
      resolveMachineValue(MACHINE_CONFIG, {}, {}, 'hub.port', path, silent, freshWarnings()),
    ).toBe(7778)
  })

  test('warns once when a legacy environment variable supplies the value', () => {
    const warnings: string[] = []
    const warned = new Set<string>()
    for (let index = 0; index < 2; index++) {
      resolveMachineValue(
        MACHINE_CONFIG,
        { ORCH_LOCAL_MODEL: 'legacy' },
        {},
        'model_host.model',
        path,
        (message) => warnings.push(message),
        warned,
      )
    }
    expect(warnings).toEqual(['ORCH_LOCAL_MODEL is deprecated; use ORCH_MODEL_HOST_MODEL'])
  })

  test('refuses an unknown file key with its key and path', () => {
    expect(() =>
      resolveMachineValue(
        MACHINE_CONFIG,
        {},
        { hub: { prot: 9000 } },
        'hub.port',
        path,
        silent,
        freshWarnings(),
      ),
    ).toThrow(`refusing machine config ${path}: unknown key hub.prot`)
  })

  test('refuses a file value with the wrong type', () => {
    expect(() =>
      resolveMachineValue(
        MACHINE_CONFIG,
        {},
        { hub: { port: '9000' } },
        'hub.port',
        path,
        silent,
        freshWarnings(),
      ),
    ).toThrow(`refusing machine config ${path}: key hub.port must be an integer`)
  })

  test('preserves the empty transcript-root disable value', () => {
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { HUB_TRANSCRIPT_ROOT: '' },
        { hub: { transcript_root: '/transcripts' } },
        'hub.transcript_root',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe('')
  })

  test('expands HOME in path defaults', () => {
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { HOME: '/home/operator' },
        {},
        'projects.clone_root',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe('/home/operator/Projects')
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { HOME: '/home/operator' },
        {},
        'hub.transcript_root',
        path,
        silent,
        freshWarnings(),
      ),
    ).toBe('/home/operator/.claude/projects')
  })

  test('reads a machine value from the configured root and otherwise uses its default', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-config-adapter-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      expect(readMachineValue('hub.port', env)).toBe(7778)
      mkdirSync(config)
      writeFileSync(join(config, 'machine.toml'), '[hub]\nport = 9000\n')
      expect(readMachineValue('hub.port', env)).toBe(9000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an invalid environment value names the variable and key', () => {
    expect(() =>
      resolveMachineValue(
        MACHINE_CONFIG,
        { HUB_PORT: 'wrong' },
        {},
        'hub.port',
        path,
        silent,
        freshWarnings(),
      ),
    ).toThrow(
      'refusing machine config key hub.port: HUB_PORT must be an integer; set HUB_PORT to an integer or unset it',
    )
  })
})

describe('machine permission overlay', () => {
  test('pure permission edits add, remove, drop, and undrop without mutating the input', () => {
    const original = { allow: ['Bash(git status)'], drop: { deny: ['Read(.env)'] } }
    const added = editMachinePermissionTable(original, 'add', 'allow', 'Bash(git diff)')
    expect(added).toEqual({
      changed: true,
      permissions: {
        allow: ['Bash(git status)', 'Bash(git diff)'],
        drop: { deny: ['Read(.env)'] },
      },
    })
    expect(original).toEqual({ allow: ['Bash(git status)'], drop: { deny: ['Read(.env)'] } })
    expect(
      editMachinePermissionTable(added.permissions, 'remove', 'allow', 'Bash(git status)'),
    ).toMatchObject({ changed: true, permissions: { allow: ['Bash(git diff)'] } })

    const dropped = editMachinePermissionTable(original, 'drop', 'ask', 'Bash(rm *)')
    expect(dropped.permissions.drop).toEqual({ deny: ['Read(.env)'], ask: ['Bash(rm *)'] })
    expect(editMachinePermissionTable(dropped.permissions, 'undrop', 'ask', 'Bash(rm *)')).toEqual({
      changed: true,
      permissions: original,
    })
    expect(editMachinePermissionTable(original, 'add', 'allow', 'Bash(git status)').changed).toBe(
      false,
    )
  })

  test('validates all optional lists and rejects malformed or unknown permission keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-permissions-schema-'))
    const config = join(root, 'config')
    const env = { HOME: root, [CONFIG_HOME_ENV]: config }
    try {
      mkdirSync(config)
      writeFileSync(
        join(config, 'machine.toml'),
        '[permissions]\nallow = ["Bash(git status)"]\n[permissions.drop]\ndeny = ["Read(.env)"]\n',
      )
      expect(readMachinePermissions(env)).toEqual({
        additions: { allow: ['Bash(git status)'], ask: [], deny: [] },
        drop: { allow: [], ask: [], deny: ['Read(.env)'] },
      })
      writeFileSync(join(config, 'machine.toml'), '[permissions]\nallow = "wrong"\n')
      expect(() => readMachinePermissions(env)).toThrow('permissions must contain only')
      writeFileSync(join(config, 'machine.toml'), '[permissions]\nextra = []\n')
      expect(() => readMachinePermissions(env)).toThrow('permissions must contain only')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves comments and unrelated tables while editing and creates a missing file', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-permissions-write-'))
    const config = join(root, 'config')
    const env = { HOME: root, [CONFIG_HOME_ENV]: config }
    try {
      mkdirSync(config)
      const file = join(config, 'machine.toml')
      writeFileSync(file, '# operator note\n[hub]\nport = 9000 # keep this\n')
      editMachinePermission('add', 'allow', 'Bash(git status)', env)
      const edited = readFileSync(file, 'utf8')
      expect(edited).toContain('# operator note')
      expect(edited).toContain('port = 9000 # keep this')
      expect(edited).toContain('Bash(git status)')

      rmSync(file)
      editMachinePermission('drop', 'ask', 'Bash(rm *)', env)
      expect(readMachinePermissions(env).drop.ask).toEqual(['Bash(rm *)'])
      setMachineAutonomy('autonomy.stage.review', 'auto', env)
      expect(readFileSync(file, 'utf8')).toContain('review = "auto"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('writing ship-to removes the stored release leaf in the same file write', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-ship-to-write-'))
    const config = join(root, 'config')
    const env = { HOME: root, [CONFIG_HOME_ENV]: config }
    try {
      mkdirSync(config)
      const file = join(config, 'machine.toml')
      writeFileSync(file, '[autonomy]\nrelease = "push"\n')
      setMachineAutonomy('autonomy.release', 'production', env)
      const written = readFileSync(file, 'utf8')
      expect(written).toContain('ship-to = "production"')
      expect(written).not.toContain('release =')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses secret-shaped rules on write without printing the rule', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-permissions-secret-write-'))
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    const secret = 'token=not-a-real-secret'
    try {
      expect(() => editMachinePermission('add', 'allow', secret, env)).toThrow(
        /secret-shaped permission rule at permissions\.allow\[0\]/,
      )
      try {
        editMachinePermission('add', 'allow', secret, env)
      } catch (error) {
        expect(String(error)).not.toContain(secret)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a secret-shaped rule read from disk with its drop list and position', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-permissions-secret-read-'))
    const config = join(root, 'config')
    const env = { HOME: root, [CONFIG_HOME_ENV]: config }
    const secret = 'Authorization: secret-value'
    try {
      mkdirSync(config)
      writeFileSync(
        join(config, 'machine.toml'),
        `[permissions.drop]\nask = ["Bash(git status)", "${secret}"]\n`,
      )
      let message = ''
      try {
        readMachinePermissions(env)
      } catch (error) {
        message = String(error)
      }
      expect(message).toContain('secret-shaped permission rule at permissions.drop.ask[1]')
      expect(message).not.toContain(secret)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
