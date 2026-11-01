import { describe, expect, test } from 'bun:test'
import { maskedRanges } from './prose-mask.ts'

function masked(text: string, value: string): boolean {
  const start = text.indexOf(value)
  return maskedRanges(text).some((range) => start < range.end && start + value.length > range.start)
}

describe('prose masks', () => {
  const cases = [
    ['YAML frontmatter', '---\nword: hidden\n---\nordinary', 'hidden'],
    ['fenced code', '```ts\nhidden\n```\nordinary', 'hidden'],
    ['inline code', 'Use `hidden` and ordinary.', 'hidden'],
    ['URL', 'See https://example.com/hidden and ordinary.', 'https://example.com/hidden'],
    ['markdown target', 'See [ordinary](docs/hidden.md) now.', 'docs/hidden.md'],
    ['slash path', 'Open shared/hidden and ordinary.', 'shared/hidden'],
    ['home path', 'Open ~/hidden and ordinary.', '~/hidden'],
    ['absolute path', 'Open /tmp/hidden and ordinary.', '/tmp/hidden'],
    ['relative path', 'Open ./hidden and ordinary.', './hidden'],
    ['parent path', 'Open ../hidden and ordinary.', '../hidden'],
    ['file extension', 'Open hidden.json and ordinary.', 'hidden.json'],
    ['task key', 'Read DEV-2016 and ordinary.', 'DEV-2016'],
    ['note reference', 'Read bottega#1358 and ordinary.', 'bottega#1358'],
    [
      'UUID',
      'Read 123e4567-e89b-12d3-a456-426614174000 and ordinary.',
      '123e4567-e89b-12d3-a456-426614174000',
    ],
    ['hex identifier', 'Read deadb33f and ordinary.', 'deadb33f'],
    ['long flag', 'Use --hidden and ordinary.', '--hidden'],
    ['short flag', 'Use -x and ordinary.', '-x'],
  ] as const

  for (const [name, text, value] of cases) {
    test(`masks ${name} without masking ordinary prose`, () => {
      expect(masked(text, value)).toBe(true)
      expect(masked(text, 'ordinary')).toBe(false)
    })
  }
})
