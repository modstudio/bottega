import { afterEach, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { REF_GUARD_RUNTIME_ASSET, registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { assertSharedRefGuardOutsideWritableRoots } from './ref-guard.ts'
import { refGuardRuntimePath, resolveRefGuardHook } from './ref-guard-runtime.ts'

afterEach(() => registerEmbeddedAssets(null))

test('the ref guard path selects checkout and extracted locations without mixing roots', () => {
  expect(
    refGuardRuntimePath({
      embeddedVersion: null,
      sourceRoot: '/checkout/orchestrator',
      stateRoot: '/state',
    }),
  ).toBe('/checkout/orchestrator/hooks/reference-transaction')
  expect(
    refGuardRuntimePath({
      embeddedVersion: '1.2.3',
      sourceRoot: '',
      stateRoot: '/state',
    }),
  ).toBe('/state/runtime/1.2.3/ref-guard/reference-transaction')
})

test('dispatch refuses a resolved guard executable inside a writable root', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ref-guard-boundary-'))
  try {
    const writable = join(scratch, 'writable')
    const hookDir = join(scratch, 'hooks')
    const guard = join(writable, 'reference-transaction')
    mkdirSync(writable)
    mkdirSync(hookDir)
    writeFileSync(guard, '#!/bin/sh\n')
    expect(() => assertSharedRefGuardOutsideWritableRoots(hookDir, guard, [writable])).toThrow(
      'THE GUARD LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE invariant failed',
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a symlinked runtime version directory is quarantined before guard extraction', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ref-guard-extract-'))
  const state = join(scratch, 'state')
  const version = join(state, 'runtime', '1.2.3')
  const planted = join(scratch, 'planted-version')
  const bytes = '#!/bin/sh\nexit 0\n'
  try {
    mkdirSync(dirname(version), { recursive: true })
    symlinkSync(planted, version)
    registerEmbeddedAssets({
      assets: { [REF_GUARD_RUNTIME_ASSET.packagePath]: bytes },
      files: {},
      manifest: {
        name: PLATFORM_NAME,
        version: '1.2.3',
        built: '2026-10-05T00:00:00.000Z',
        commit: 'abcdef1234567890',
      },
    })

    const hook = resolveRefGuardHook({ BOTTEGA_STATE_HOME: state }, '')
    expect(lstatSync(version).isSymbolicLink()).toBe(false)
    expect(readFileSync(hook, 'utf8')).toBe(bytes)
    expect(
      readdirSync(dirname(version)).filter((name) => name.startsWith('1.2.3.invalid-')),
    ).toHaveLength(1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
