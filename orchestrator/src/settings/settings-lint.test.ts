import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { adoptionCandidates, lintSettings } from './settings-lint.ts'

describe('lintSettings', () => {
  test('flags a rule duplicated within a target', () => {
    const findings = lintSettings([
      { id: 'user', settings: { permissions: { allow: ['a', 'a'] }, hooks: {} } },
    ])
    expect(findings.some((finding) => finding.rule === 'settings/duplicate-within')).toBe(true)
  })

  test('flags a rule duplicated between user and a project', () => {
    const findings = lintSettings([
      { id: 'user', settings: { permissions: { allow: ['shared'] }, hooks: {} } },
      { id: 'alpha', settings: { permissions: { ask: ['shared'] }, hooks: {} } },
    ])
    expect(findings.some((finding) => finding.rule === 'settings/duplicate-across')).toBe(true)
  })

  test('normalizes installed and PATH forms for the front door', () => {
    const findings = lintSettings([
      {
        id: 'alpha',
        settings: {
          permissions: {
            allow: [
              `Bash(./bin/${PLATFORM_SLUG} run result *)`,
              `Bash(${PLATFORM_SLUG} run result *)`,
              `Bash(./bin/${PLATFORM_SLUG} task *)`,
              `Bash(${PLATFORM_SLUG} task *)`,
            ],
          },
          hooks: {},
        },
      },
    ])
    const bin = findings.filter((finding) => finding.rule === 'settings/bin-prefix')
    expect(bin.length).toBe(2)
  })

  test('flags a rule in both allow and deny', () => {
    const findings = lintSettings([
      {
        id: 'user',
        settings: { permissions: { allow: ['x'], deny: ['x'] }, hooks: {} },
      },
    ])
    expect(findings.some((finding) => finding.rule === 'settings/allow-deny')).toBe(true)
  })
})

test('adoptionCandidates labels each list and store presence', () => {
  expect(
    adoptionCandidates(
      { allow: ['a', 'b'], ask: [], deny: ['c'] },
      { allow: ['a'], ask: [], deny: [] },
    ),
  ).toEqual({
    allow: [
      { rule: 'a', inStore: true },
      { rule: 'b', inStore: false },
    ],
    ask: [],
    deny: [{ rule: 'c', inStore: false }],
  })
})
