import { describe, expect, test } from 'bun:test'
import { isDeclaredHubUiSourceLocation, uiArchitectureRules } from './architecture-ui-layers.ts'

describe('hub-ui source locations', () => {
  test('distinguishes declared locations from undeclared production sources', () => {
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/root-file.ts')).toBe(false)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/undeclared/probe.ts')).toBe(false)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/button/nested/icon.tsx')).toBe(true)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/styles/theme.css')).toBe(true)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/undeclared/probe.test.ts')).toBe(true)
  })
})

describe('hub-ui variant dependency boundary', () => {
  test('covers repository sources outside hub-ui and excepts only the shared variant module', () => {
    const rule = uiArchitectureRules((dependency) => dependency, 'hub-ui-package').find(
      ({ name }) => name === 'hub-ui-variant-dependencies-have-one-entry',
    )!
    const source = new RegExp(rule.from.path)
    expect(source.test('hub/web/src/docs/code-section.tsx')).toBe(true)
    expect(source.test('orchestrator/src/cli/orch.ts')).toBe(true)
    expect(source.test('hub/ui/src/text/variant.ts')).toBe(false)
    expect(new RegExp(rule.to.path!).test('tailwind-merge')).toBe(true)
  })
})
