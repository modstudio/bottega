import { expect, test } from 'bun:test'
import { modules } from './architecture.ts'
import {
  architectureUndeclaredModules,
  countUndeclaredModules,
} from './architecture-undeclared-modules.ts'
import { undeclaredModulesBaseline } from './quality/undeclared-modules-baseline.ts'

test('all manifest modules are not in violations', () => {
  const manifestFiles = new Set(modules.map(({ file }) => file))
  const baseline = undeclaredModulesBaseline

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // All declared files should not appear in violations
  for (const { file } of modules) {
    expect(
      violations.some((v) => v.startsWith(`${file}:`)),
      `File ${file} should not be a violation`,
    ).toBe(false)
  }
})

test('baselined files are not in violations', () => {
  const manifestFiles = new Set<string>()
  const baseline = undeclaredModulesBaseline

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // All baselined files should not appear in "missing manifest module" violations
  for (const file of baseline) {
    expect(violations.some((v) => v.includes(`${file}: missing manifest module`))).toBe(false)
  }
})

test('stale baseline entries are detected', () => {
  // If a baseline file is also in manifest, it's a stale entry
  const manifestFiles = new Set(modules.map(({ file }) => file))
  const baseline = [...undeclaredModulesBaseline, 'orchestrator/src/route/route-policy.ts'] // This one IS in manifest

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // The stale entry should be reported
  expect(violations).toContainEqual(
    'orchestrator/src/route/route-policy.ts: stale baseline entry - remove from baseline (canon 10-code: A module is one concern)',
  )
})

test('declared file is not a violation', () => {
  const manifestFiles = new Set<string>()
  // Add a file that's actually in the manifest
  const firstModule = modules[0]
  if (firstModule) manifestFiles.add(firstModule.file)
  const baseline: string[] = []

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // The declared file should not be a violation
  expect(violations.some((v) => v.includes(`${firstModule!.file}: missing manifest module`))).toBe(
    false,
  )
})

test('countUndeclaredModules reports zero with proper baseline', () => {
  const manifestFiles = new Set(modules.map(({ file }) => file))
  const baseline = undeclaredModulesBaseline

  const count = countUndeclaredModules(manifestFiles, baseline)

  expect(count).toBe(0)
})

test('test files are ignored in check', () => {
  const manifestFiles = new Set<string>()
  const baseline: string[] = []

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // Test files should never appear in violations
  expect(violations.some((v) => v.includes('.test.ts'))).toBe(false)
  expect(violations.some((v) => v.includes('.spec.ts'))).toBe(false)
})

test('fixture files are ignored in check', () => {
  const manifestFiles = new Set<string>()
  const baseline: string[] = []

  const violations = architectureUndeclaredModules(manifestFiles, baseline)

  // Fixture files should never appear in violations
  expect(violations.some((v) => v.includes('.fixture.ts'))).toBe(false)
})
