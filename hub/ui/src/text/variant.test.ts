import { describe, expect, test } from 'bun:test'
import { mergeClasses, variant } from './variant.ts'

describe('theme-aware class merging', () => {
  test.each([
    ['text-md text-text-muted', 'text-md text-text-muted'],
    ['text-sm text-status-text', 'text-sm text-status-text'],
    ['bg-surface-page border-border-default', 'bg-surface-page border-border-default'],
    ['shadow-raised border-border-default', 'shadow-raised border-border-default'],
    ['text-sm text-md', 'text-md'],
  ])('merges %s', (classes, expected) => {
    expect(mergeClasses(classes)).toBe(expected)
  })

  test('caller classes override a custom theme size through the configured variant function', () => {
    const control = variant({ base: 'h-control-sm' })
    expect(control({ class: 'h-control-lg' })).toBe('h-control-lg')
  })
})
