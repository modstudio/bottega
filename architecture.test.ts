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
