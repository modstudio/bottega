import { describe, expect, test } from 'bun:test'
import { isDeclaredHubUiSourceLocation } from './architecture-ui-layers.ts'

describe('hub-ui source locations', () => {
  test('distinguishes declared locations from undeclared production sources', () => {
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/root-file.ts')).toBe(false)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/undeclared/probe.ts')).toBe(false)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/button/nested/icon.tsx')).toBe(true)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/styles/theme.css')).toBe(true)
    expect(isDeclaredHubUiSourceLocation('hub/ui/src/undeclared/probe.test.ts')).toBe(true)
  })
})
