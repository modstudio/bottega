import { expect, test } from 'bun:test'
import { hookRuntimeOpenFindings, runtimeAssetCallFindings } from './check-runtime-assets.ts'

test('refuses a new assetPath that a release does not ship', () => {
  expect(
    runtimeAssetCallFindings(
      "const helper = assetPath('shared', 'new-helper.py')\n",
      'shared/example.ts',
    ),
  ).toEqual([{ path: 'shared/example.ts', line: 1, asset: 'shared/new-helper.py' }])
})

test('accepts declared runtime and documented checkout-only assets', () => {
  expect(
    runtimeAssetCallFindings(
      "assetPath('shared', 'store-write-lock.c')\nassetPath('node_modules', '.bin', 'codex-acp')\n",
      'shared/example.ts',
    ),
  ).toEqual([])
})

test('refuses an unshipped repo-relative file opened by a production hook', () => {
  expect(
    hookRuntimeOpenFindings(
      "TABLE = Path(__file__).resolve().parents[2] / 'shared' / 'new-table.json'\n",
      'orchestrator/hooks/example.py',
    ),
  ).toEqual([
    {
      path: 'orchestrator/hooks/example.py',
      line: 1,
      asset: 'shared/new-table.json',
    },
  ])
})
