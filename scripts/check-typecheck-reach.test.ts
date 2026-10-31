import { expect, test } from 'bun:test'
import { uncoveredTypeScriptPaths } from './check-typecheck-reach.ts'

test('reports a tracked TypeScript file that no typecheck leg covers', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [[]])).toEqual(['scripts/example.ts'])
})

test('does not report a tracked TypeScript file covered by one leg', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [['scripts/example.ts']])).toEqual([])
})

test('does not report a tracked TypeScript file covered by two legs', () => {
  expect(
    uncoveredTypeScriptPaths(
      ['shared/example.ts'],
      [['shared/example.ts'], ['shared/example.ts']],
    ),
  ).toEqual([])
})
