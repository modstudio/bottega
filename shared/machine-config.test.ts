import { describe, expect, test } from 'bun:test'
import { MACHINE_CONFIG, resolveMachineValue } from './machine-config.ts'

const path = '/config/platform/machine.toml'

describe('machine config resolution', () => {
  test('resolves canonical environment over legacy, file, and default', () => {
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { ORCH_MODEL_HOST_URL: 'canonical', ORCH_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
      ),
    ).toBe('canonical')
    expect(
      resolveMachineValue(
        MACHINE_CONFIG,
        { ORCH_LOCAL_BASE_URL: 'legacy' },
        { model_host: { url: 'file' } },
        'model_host.url',
        path,
        () => {},
        new Set(),
      ),
    ).toBe('legacy')
    expect(resolveMachineValue(MACHINE_CONFIG, {}, { hub: { port: 9000 } }, 'hub.port', path)).toBe(
      9000,
    )
    expect(resolveMachineValue(MACHINE_CONFIG, {}, {}, 'hub.port', path)).toBe(7778)
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
      resolveMachineValue(MACHINE_CONFIG, {}, { hub: { prot: 9000 } }, 'hub.port', path),
    ).toThrow(`refusing machine config ${path}: unknown key hub.prot`)
  })

  test('refuses a file value with the wrong type', () => {
    expect(() =>
      resolveMachineValue(MACHINE_CONFIG, {}, { hub: { port: '9000' } }, 'hub.port', path),
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
      ),
    ).toBe('')
  })
})
