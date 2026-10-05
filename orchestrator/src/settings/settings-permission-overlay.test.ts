import { describe, expect, test } from 'bun:test'
import { mergeMachinePermissionOverlay } from './settings-permission-overlay.ts'

const hosted = {
  permissions: {
    allow: ['shared', 'hosted-only', 'shared'],
    ask: ['ask-hosted'],
    deny: ['deny-hosted'],
  },
  hooks: { SessionStart: [] },
}

describe('machine permission overlay merge', () => {
  test('adds, drops, deduplicates in first-occurrence order, and reports unmatched drops', () => {
    const result = mergeMachinePermissionOverlay(hosted, {
      additions: {
        allow: ['shared', 'machine-only', 'machine-only'],
        ask: [],
        deny: [],
      },
      drop: { allow: ['hosted-only', 'missing'], ask: [], deny: [] },
    })
    expect(result.settings).toEqual({
      permissions: {
        allow: ['shared', 'machine-only'],
        ask: ['ask-hosted'],
        deny: ['deny-hosted'],
      },
      hooks: hosted.hooks,
    })
    expect(result.unmatchedDrops).toEqual([{ list: 'allow', rule: 'missing' }])
  })

  test('keeps lists isolated', () => {
    const result = mergeMachinePermissionOverlay(hosted, {
      additions: { allow: [], ask: ['deny-hosted'], deny: [] },
      drop: { allow: [], ask: [], deny: ['ask-hosted'] },
    })
    expect(result.settings.permissions).toEqual({
      allow: ['shared', 'hosted-only'],
      ask: ['ask-hosted', 'deny-hosted'],
      deny: ['deny-hosted'],
    })
    expect(result.unmatchedDrops).toEqual([{ list: 'deny', rule: 'ask-hosted' }])
  })
})
