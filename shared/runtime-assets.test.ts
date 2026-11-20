import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { extractedRuntimeAssetPath, extractedRuntimeRootPath } from './runtime-assets.ts'

test('runtime layout has one owner for roots and assets', () => {
  expect(extractedRuntimeRootPath('/state', '1.2.3')).toBe('/state/runtime/1.2.3/assets')
  expect(
    extractedRuntimeAssetPath('/state', '1.2.3', {
      destination: 'orchestrator/hooks/reference-transaction',
    }),
  ).toBe(join('/state/runtime/1.2.3/assets', 'orchestrator/hooks/reference-transaction'))
})
