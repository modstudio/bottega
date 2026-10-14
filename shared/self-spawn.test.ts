import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_NAME } from './brand.ts'
import { registerEmbeddedAssets } from './embedded-assets.ts'
import { assetPath } from './install-root.ts'
import { BOTTEGA_ENTRY_PROTOCOL, type BottegaEntry, bottegaEntryArgv } from './self-spawn.ts'

const entries: BottegaEntry[] = [
  'orch',
  'hub',
  'run-exec',
  'ask-server',
  'ask-proxy',
  'retrieval-search',
]

afterEach(() => registerEmbeddedAssets(null))

test('source entries preserve their current argv prefixes', () => {
  expect(bottegaEntryArgv('orch')).toEqual([assetPath('bin', 'orch')])
  expect(bottegaEntryArgv('hub')).toEqual([assetPath('bin', 'hub')])
  expect(bottegaEntryArgv('run-exec')).toEqual([
    process.env.ORCH_EXEC_PATH ?? process.execPath,
    '--no-env-file',
    assetPath('orchestrator', 'src', 'run', 'exec.ts'),
  ])
  expect(bottegaEntryArgv('ask-server')).toEqual([
    process.execPath,
    '--no-env-file',
    assetPath('orchestrator', 'src', 'cli', 'orch.ts'),
    'ask-server',
  ])
  expect(bottegaEntryArgv('ask-proxy')).toEqual([
    Bun.which('bun') ?? process.execPath,
    '--no-env-file',
    assetPath('orchestrator', 'src', 'ask', 'ask-proxy.ts'),
    'ask-server',
  ])
  expect(bottegaEntryArgv('retrieval-search')).toEqual([assetPath('bin', 'retrieval-search')])
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
})
