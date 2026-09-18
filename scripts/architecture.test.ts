import { expect, test } from 'bun:test'
import { architectureRules, exactArchitecturePath, inversions, modules } from './architecture.ts'

test('every module emits its exact allowlist as a forbidden rule', () => {
  const { forbidden } = architectureRules()
  for (const entry of modules) {
    const rule = forbidden.find(
      (candidate) => candidate.from.path === exactArchitecturePath(entry.file),
    )
    expect(rule?.to.pathNot).toEqual(entry.allowed.map(exactArchitecturePath))
  }
})

test('every inversion pair emits a forbidden rule', () => {
  const { forbidden } = architectureRules()
  for (const inversion of inversions) {
    expect(
      forbidden.some(
        (rule) =>
          rule.from.path === exactArchitecturePath(inversion.from) &&
          rule.to.path === exactArchitecturePath(inversion.to),
      ),
    ).toBe(true)
  }
})

test('hosted report delivery transitively rejects the local store and git', () => {
  const rule = architectureRules().forbidden.find(
    (candidate) =>
      candidate.name === 'import-hosted-report-delivery-no-local-store-transitive-boundary',
  )
  expect(rule).toBeDefined()
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery.ts'))
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery-hosted.ts'))
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery-cli.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('hub/src/db.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('shared/git.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('bun:sqlite'))
  expect(rule?.to.reachable).toBe(true)
})
