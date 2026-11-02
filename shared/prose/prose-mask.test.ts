import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../brand.ts'
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
    ['note reference', `Read ${PLATFORM_NAME}#1358 and ordinary.`, `${PLATFORM_NAME}#1358`],
    [
      'UUID',
      'Read 123e4567-e89b-12d3-a456-426614174000 and ordinary.',
      '123e4567-e89b-12d3-a456-426614174000',
    ],
    ['hex identifier', 'Read deadb33f and ordinary.', 'deadb33f'],
    ['long flag', 'Use --hidden and ordinary.', '--hidden'],
    ['short flag', 'Use -x and ordinary.', '-x'],
    ['plain ANSI escape', 'mistake \x1b[0m ordinary', '\x1b[0m'],
    ['colored ANSI escape', 'mistake \x1b[1;31m ordinary', '\x1b[1;31m'],
    ['slice token', 'mistake s1 ordinary', 's1'],
    ['version token', 'mistake v41 ordinary', 'v41'],
    ['mixed token', 'mistake k7b ordinary', 'k7b'],
    ['numbered product', 'mistake sqlite3 ordinary', 'sqlite3'],
    ['duration token', 'mistake 500s ordinary', '500s'],
    ['time suffix', 'mistake 14Z ordinary', '14Z'],
    ['camelCase identifier', 'mistake apiCallSlow ordinary', 'apiCallSlow'],
    ['PascalCase identifier', 'mistake ApiCallSlow ordinary', 'ApiCallSlow'],
    ['session identifier', 'mistake SessionStart ordinary', 'SessionStart'],
    ['hook identifier', 'mistake PreToolUse ordinary', 'PreToolUse'],
    ['snake case identifier', 'mistake api_call_slow ordinary', 'api_call_slow'],
    ['all-capital token', 'mistake ENOENT ordinary', 'ENOENT'],
    ['all-capital acronym', 'mistake RLS ordinary', 'RLS'],
    ['plural all-capital token', 'mistake SKUs ordinary', 'SKUs'],
    ['single letter', 'mistake x ordinary', 'x'],
  ] as const

  for (const [name, text, value] of cases) {
    test(`masks ${name} without masking ordinary prose`, () => {
      expect(masked(text, value)).toBe(true)
      expect(masked(text, 'ordinary')).toBe(false)
      if (text.includes('mistake')) expect(masked(text, 'mistake')).toBe(false)
    })
  }

  test.each(['a', 'A', 'I'])('does not mask the prose token %s', (value) => {
    expect(masked(`ordinary ${value} prose`, value)).toBe(false)
  })
})
