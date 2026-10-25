import { describe, expect, test } from 'bun:test'
import {
  mergeProjectSettings,
  parseSettingsPatch,
  settingsPatchEffect,
} from './project-settings-patch.ts'

describe('parseSettingsPatch', () => {
  test('accepts a JSON object', () => {
    expect(parseSettingsPatch('{"trunk":"main"}')).toEqual({ trunk: 'main' })
  })

  test.each(['"hi"', '[7,8]', 'null'])('refuses a non-object top-level patch: %s', (json) => {
    expect(() => parseSettingsPatch(json)).toThrow(
      '--settings must be a JSON object, for example {"trunk":"main"}',
    )
  })

  test('refuses invalid JSON and preserves the parse error detail', () => {
    expect(() => parseSettingsPatch('{')).toThrow(
      /--settings must be a JSON object, for example \{"trunk":"main"\}: SyntaxError:/,
    )
  })
})

describe('mergeProjectSettings', () => {
  test('a nested null removes only that key while an omitted sibling remains', () => {
    expect(
      mergeProjectSettings(
        { review: { lenses: ['correctness'], risk: 'high' }, trunk: 'main' },
        { review: { lenses: null } },
      ),
    ).toEqual({ review: { risk: 'high' }, trunk: 'main' })
  })

  test('an array replaces wholesale', () => {
    expect(mergeProjectSettings({ keyPrefixes: ['DEV', 'OPS'] }, { keyPrefixes: ['APP'] })).toEqual(
      { keyPrefixes: ['APP'] },
    )
  })

  test('a nested null under an absent parent removes the nested key', () => {
    expect(mergeProjectSettings({ trunk: 'main' }, { review: { lenses: null } })).toEqual({
      trunk: 'main',
      review: {},
    })
  })

  test('a nested null under a scalar parent removes the nested key', () => {
    expect(mergeProjectSettings({ color: 'blue' }, { color: { shade: null } })).toEqual({
      color: {},
    })
  })

  test('an object replaces a scalar', () => {
    expect(mergeProjectSettings({ review: 'all' }, { review: { risk: 'high' } })).toEqual({
      review: { risk: 'high' },
    })
  })

  test('a scalar replaces an object', () => {
    expect(mergeProjectSettings({ review: { risk: 'high' } }, { review: 'all' })).toEqual({
      review: 'all',
    })
  })
})

describe('settingsPatchEffect', () => {
  test('reports sorted added, changed, and removed dotted paths', () => {
    expect(
      settingsPatchEffect(
        {
          review: { risk: 'high', lenses: ['correctness'] },
          worktree: { branch: 'dev/{key}' },
          trunk: 'main',
        },
        {
          review: { risk: 'low', profile: 'default' },
          worktree: { branch: 'dev/{key}' },
          color: 'blue',
        },
      ),
    ).toEqual({
      added: ['color', 'review.profile'],
      changed: ['review.risk'],
      removed: ['review.lenses', 'trunk'],
    })
  })

  test('structurally equal settings produce no effects regardless of object key order', () => {
    expect(
      settingsPatchEffect(
        { review: { risk: { high: true, reason: 'security' } } },
        { review: { risk: { reason: 'security', high: true } } },
      ),
    ).toEqual({ added: [], changed: [], removed: [] })
  })

  test('a whole removed object is reported once', () => {
    expect(settingsPatchEffect({ review: { risk: 'high', lenses: ['correctness'] } }, {})).toEqual({
      added: [],
      changed: [],
      removed: ['review'],
    })
  })
})
