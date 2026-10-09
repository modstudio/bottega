import { describe, expect, test } from 'bun:test'
import { phpPolicyRulesFromSettings } from './test-substance-project-policy.ts'

describe('PHP test-substance project policy', () => {
  test('returns the declaration and universal-only policy when it is absent', () => {
    expect(
      phpPolicyRulesFromSettings({ testSubstance: { phpPolicyRules: ['createMock'] } }),
    ).toEqual(['createMock'])
    expect(phpPolicyRulesFromSettings(undefined)).toEqual([])
    expect(phpPolicyRulesFromSettings({})).toEqual([])
  })
})
