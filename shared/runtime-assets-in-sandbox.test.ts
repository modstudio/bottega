import { describe, expect, test } from 'bun:test'
import { REF_GUARD_RUNTIME_ASSET } from './embedded-assets.ts'
import { extractedRuntimeAssetPath } from './runtime-assets.ts'
import { WORKER_RUNTIME_ASSETS, workerRuntimeAssetPaths } from './runtime-assets-in-sandbox.ts'

test('worker runtime assets resolve only their exact declared paths', () => {
  const paths = workerRuntimeAssetPaths('/state', '1.2.3')
  expect(paths).toEqual([
    '/state/runtime/1.2.3/sandbox-runtime',
    '/state/runtime/1.2.3/assets/orchestrator/hooks/reference-transaction',
  ])
  expect(paths).toContain(extractedRuntimeAssetPath('/state', '1.2.3', REF_GUARD_RUNTIME_ASSET))
  expect(Object.keys(WORKER_RUNTIME_ASSETS)).toEqual(['sandboxRuntime', 'refGuard'])
})

describe.each([
  ['empty', ''],
  ['absolute', '/outside'],
  ['parent segment', 'ref-guard/../outside'],
  ['version root', '.'],
  ['above version root', '../outside'],
] as const)('worker runtime asset validation: %s', (_name, entry) => {
  test(`refuses ${JSON.stringify(entry)}`, () => {
    expect(() => workerRuntimeAssetPaths('/state', '1.2.3', { fixture: entry })).toThrow()
  })
})
