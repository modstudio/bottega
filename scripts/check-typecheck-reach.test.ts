import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS } from './check-plan.ts'
import { uncoveredTypeScriptPaths } from './check-typecheck-reach.ts'

test('reports a tracked TypeScript file that no typecheck leg covers', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [[]])).toEqual(['scripts/example.ts'])
})

test("hub/web's declared configs match its chained typecheck commands", () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  const packageJson = JSON.parse(readFileSync(`${root}/hub/web/package.json`, 'utf8')) as {
    scripts: { typecheck: string }
  }
  const chained = [...packageJson.scripts.typecheck.matchAll(/--cwd \.\.\/([^ ]+) typecheck/g)].map(
    (match) => `hub/${match[1]}/tsconfig.json`,
  )
  const declared = CHECK_LEGS.find((leg) => leg.name === 'hub/web')!.typecheckConfigs
  const actual: readonly string[] = declared
  expect(actual).toEqual(['hub/web/tsconfig.json', ...chained])
})

test('does not report a tracked TypeScript file covered by one leg', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [['scripts/example.ts']])).toEqual([])
})

test('does not report a tracked TypeScript file covered by two legs', () => {
  expect(
    uncoveredTypeScriptPaths(['shared/example.ts'], [['shared/example.ts'], ['shared/example.ts']]),
  ).toEqual([])
})
