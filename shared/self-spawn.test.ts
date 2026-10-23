import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import { registerEmbeddedAssets } from './embedded-assets.ts'
import { assetPath } from './install-root.ts'
import {
  BOTTEGA_ENTRY_PROTOCOL,
  type BottegaEntry,
  bottegaEntryArgv,
  installedBottegaExecutable,
  sourceBunExecutable,
} from './self-spawn.ts'

const entries: BottegaEntry[] = [
  PLATFORM_SLUG,
  'run-exec',
  'ask-server',
  'ask-proxy',
  'retrieval-search',
]

afterEach(() => registerEmbeddedAssets(null))

test('source entries preserve their current argv prefixes', () => {
  expect(bottegaEntryArgv(PLATFORM_SLUG)).toEqual([assetPath('bin', PLATFORM_SLUG)])
  expect(bottegaEntryArgv('run-exec')).toEqual([
    process.env.ORCH_EXEC_PATH ?? process.execPath,
    '--no-env-file',
    assetPath('orchestrator', 'src', 'run', 'exec.ts'),
  ])
  expect(bottegaEntryArgv('ask-server')).toEqual([
    assetPath('bin', PLATFORM_SLUG),
    'mcp',
    'ask-server',
  ])
  expect(bottegaEntryArgv('mcp-reader-proxy')).toEqual([
    assetPath('bin', PLATFORM_SLUG),
    'mcp',
    'reader-proxy',
  ])
  expect(bottegaEntryArgv('ask-proxy')).toEqual([
    sourceBunExecutable(),
    '--no-env-file',
    assetPath('orchestrator', 'src', 'ask', 'ask-proxy.ts'),
    'ask-server',
  ])
  expect(bottegaEntryArgv('retrieval-search')).toEqual([assetPath('bin', 'retrieval-search')])
})

test('source Bun resolution prefers PATH and falls back to the current executable', () => {
  expect(sourceBunExecutable(() => '/stable/bin/bun')).toBe('/stable/bin/bun')
  expect(sourceBunExecutable(() => null)).toBe(process.execPath)
})

test('long-lived source entries use the resolved Bun executable', () => {
  for (const entry of ['ask-proxy', 'check-attribution', 'schema-check'] as const) {
    expect(bottegaEntryArgv(entry, undefined, () => '/stable/bin/bun')[0]).toBe('/stable/bin/bun')
  }
})

test('compiled entries re-execute the current binary', () => {
  registerEmbeddedAssets({
    assets: {},
    files: {},
    manifest: { name: PLATFORM_NAME, version: 'test', built: 'now', commit: 'test' },
  })
  for (const entry of entries) {
    expect(
      bottegaEntryArgv(entry, () => {
        throw new Error('compiled resolution must not inspect source executables')
      }),
    ).toEqual([process.execPath, ...BOTTEGA_ENTRY_PROTOCOL[entry].compiledArguments])
  }
  expect(installedBottegaExecutable()).toBe(process.execPath)
})
