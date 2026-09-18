import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from './config-directory.ts'
import { MACHINE_CONFIG, readMachineValue, resolveMachineValue } from './machine-config.ts'

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
