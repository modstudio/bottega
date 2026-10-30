import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { CONFIG_HOME_ENV } from './config-directory.ts'
import {
  deleteMachineValue,
  editMachinePermission,
  editMachinePermissionTable,
  listMachineEntries,
  MACHINE_CONFIG,
  machineId,
  readDelegationSettings,
  readMachinePermissions,
  readMachineValue,
  resolveMachineValue,
  setMachineAutonomy,
  setMachineValue,
  storedMachineId,
} from './machine-config.ts'

const path = '/config/platform/machine.toml'
const silent = () => {}
const freshWarnings = () => new Set<string>()

describe('machine config resolution', () => {
  test('machine identity lookup does not create config and carry-over is stable', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-id-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      expect(storedMachineId(env)).toBeNull()
      expect(() => readFileSync(join(config, 'machine.toml'), 'utf8')).toThrow()
      const legacy = '01990000-0000-7000-8000-000000001240'
      const competing = '01990000-0000-7000-8000-000000001241'
      expect(machineId(legacy, env)).toBe(legacy)
      expect(machineId(competing, env)).toBe(legacy)
      expect(storedMachineId(env)).toBe(legacy)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('machine identity lock timeout names the stale-lock remedy', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-id-lock-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      mkdirSync(config, { recursive: true })
      const lock = join(config, '.machine-id.lock')
      writeFileSync(lock, '')
      let now = 0
      expect(() =>
        machineId(null, env, {
          now: () => now,
          wait: (milliseconds) => {
            now += milliseconds
          },
          timeoutMs: 20,
          pollMs: 10,
        }),
      ).toThrow(
        `timed out waiting for machine identity lock ${lock}; remove this lock file when no process is starting`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves canonical environment over legacy, file, and default', () => {
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { BOTTEGA_MODEL_HOST_URL: 'canonical', BOTTEGA_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
        silent,
        freshWarnings(),
      ),
    ).toEqual({
      value: 'canonical',
      source: { kind: 'environment', name: 'BOTTEGA_MODEL_HOST_URL' },
    })
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { BOTTEGA_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
        silent,
        freshWarnings(),
      ),
    ).toEqual({
      value: 'legacy',
      source: { kind: 'environment', name: 'BOTTEGA_LOCAL_BASE_URL' },
    })
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
    ).toEqual({ value: 9000, source: { kind: 'machine-file' } })
    expect(
      resolveMachineValue(MACHINE_CONFIG, {}, {}, 'hub.port', path, silent, freshWarnings()),
    ).toEqual({ value: 7778, source: { kind: 'default' } })
  })

  test('warns once when a legacy environment variable supplies the value', () => {
    const warnings: string[] = []
    const warned = new Set<string>()
    for (let index = 0; index < 2; index++) {
      resolveMachineValue(
        MACHINE_CONFIG,
        { BOTTEGA_LOCAL_MODEL: 'legacy' },
        {},
        'model_host.model',
        path,
        (message) => warnings.push(message),
        warned,
      )
    }
    expect(warnings).toEqual(['BOTTEGA_LOCAL_MODEL is deprecated; use BOTTEGA_MODEL_HOST_MODEL'])
  })

  test('ignores unknown file keys and warns once per path and key', () => {
    const warnings: string[] = []
    const warned = new Set<string>()
    const parsed = {
      future_generation: 7,
      machine: { future_name: 'workstation' },
      projects: { atlas: { future_mode: 'managed' } },
      hub: { port: 9000 },
    }
    for (let index = 0; index < 2; index++) {
      expect(
        resolveMachineValue(
          MACHINE_CONFIG,
          {},
          parsed,
          'hub.port',
          path,
          (message) => warnings.push(message),
          warned,
        ),
      ).toEqual({ value: 9000, source: { kind: 'machine-file' } })
    }
    expect(warnings).toEqual([
      `machine config ${path}: ignoring unknown key future_generation; a newer ${PLATFORM_SLUG} may have written it`,
      `machine config ${path}: ignoring unknown key machine.future_name; a newer ${PLATFORM_SLUG} may have written it`,
      `machine config ${path}: ignoring unknown key projects.atlas.future_mode; a newer ${PLATFORM_SLUG} may have written it`,
    ])
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
        { BOTTEGA_TRANSCRIPT_ROOT: '' },
        { hub: { transcript_root: '/transcripts' } },
        'hub.transcript_root',
        path,
        silent,
        freshWarnings(),
      ),
    ).toEqual({
      value: '',
      source: { kind: 'environment', name: 'BOTTEGA_TRANSCRIPT_ROOT' },
    })
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
    ).toEqual({ value: '/home/operator/Projects', source: { kind: 'default' } })
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
    ).toEqual({ value: '/home/operator/.claude/projects', source: { kind: 'default' } })
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

  test('setting a declared value preserves unknown keys and their values', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-config-future-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      mkdirSync(config)
      const file = join(config, 'machine.toml')
      writeFileSync(
        file,
        'future_generation = 7\n[machine]\nfuture_name = "workstation"\n[projects.atlas]\nfuture_mode = "managed"\n[hub]\nport = 9000\n',
      )

      setMachineValue('hub.port', '9100', env)

      expect(Bun.TOML.parse(readFileSync(file, 'utf8'))).toEqual({
        future_generation: 7,
        machine: { future_name: 'workstation' },
        projects: { atlas: { future_mode: 'managed' } },
        hub: { port: 9100 },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('delegation modes default external and persist per machine', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-delegation-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      expect(readDelegationSettings(env)).toEqual({
        'delegation.implement': 'external',
        'delegation.review': 'external',
      })
      setMachineValue('delegation.review', 'harness', env)
      expect(readDelegationSettings(env)).toEqual({
        'delegation.implement': 'external',
        'delegation.review': 'harness',
      })
      expect(() => setMachineValue('delegation.review', 'sometimes', env)).toThrow(
        'key delegation.review must be one of external, harness',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('catalogue values list only when stored and delete prunes empty tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-catalogue-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      setMachineValue('hub.port', '9000', env)
      setMachineValue('routing.cost_policy', '{"enabled":false}', env)
      expect(listMachineEntries(env)).toEqual([
        { key: 'hub.port', value: '9000', scope: 'machine' },
        { key: 'routing.cost_policy', value: '{"enabled":false}', scope: 'machine' },
      ])

      deleteMachineValue('routing.cost_policy', env)
      expect(readFileSync(join(config, 'machine.toml'), 'utf8')).not.toContain('[routing]')
      expect(listMachineEntries(env)).toEqual([
        { key: 'hub.port', value: '9000', scope: 'machine' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('machine identity is validated before machine.toml is patched', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-id-validation-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      expect(() => setMachineValue('machine.id', 'work-laptop', env)).toThrow(
        `refusing machine config key machine.id: value must be a UUID; write a valid value with \`${PLATFORM_SLUG} machine config set --machine machine.id <uuid>\``,
      )
      expect(() => readFileSync(join(config, 'machine.toml'), 'utf8')).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a malformed delegation value is actionable and remains repairable', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-delegation-invalid-'))
    try {
      const config = join(root, 'config')
      const env = { HOME: root, [CONFIG_HOME_ENV]: config }
      mkdirSync(config)
      writeFileSync(join(config, 'machine.toml'), '[delegation]\nreview = "sometimes"\n')
      expect(() => readDelegationSettings(env)).toThrow(
        `key delegation.review must be one of external, harness; cleared by: ${PLATFORM_SLUG} machine config set --machine delegation.review external`,
      )
      setMachineValue('delegation.review', 'harness', env)
      expect(readDelegationSettings(env)['delegation.review']).toBe('harness')
      writeFileSync(join(config, 'machine.toml'), '[delegation]\nreview = "sometimes"\n')
      deleteMachineValue('delegation.review', env)
      expect(readDelegationSettings(env)['delegation.review']).toBe('external')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an invalid environment value names the variable and key', () => {
    expect(() =>
      resolveMachineValue(
        MACHINE_CONFIG,
        { BOTTEGA_HUB_PORT: 'wrong' },
        {},
        'hub.port',
        path,
        silent,
        freshWarnings(),
      ),
    ).toThrow(
      'refusing machine config key hub.port: BOTTEGA_HUB_PORT must be an integer; set BOTTEGA_HUB_PORT to an integer or unset it',
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
      setMachineAutonomy('autonomy.release', 'promote', env)
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
