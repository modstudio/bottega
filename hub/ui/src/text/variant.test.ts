import { describe, expect, test } from 'bun:test'
import { mergeThemeClasses } from './variant.ts'

describe('theme-aware class merging', () => {
  test.each([
    ['text-md text-text-muted', 'text-md text-text-muted'],
    ['text-sm text-status-text', 'text-sm text-status-text'],
    ['bg-surface-page border-border-default', 'bg-surface-page border-border-default'],
    ['shadow-raised border-border-default', 'shadow-raised border-border-default'],
    ['text-sm text-md', 'text-md'],
  ])('merges %s', (classes, expected) => {
    expect(mergeThemeClasses(classes)).toBe(expected)
  })
})
