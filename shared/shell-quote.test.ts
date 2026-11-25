import { expect, test } from 'bun:test'
import { parseShellQuoted, shellQuote } from './shell-quote.ts'

test('parses the canonical shell-quoted argv form losslessly', () => {
  const argv = [
    'space separated',
    "single'quote",
    'line one\nline two',
    '$HOME',
    '`command`',
    String.raw`back\slash`,
    'שלום',
    '',
  ]
  const command = argv.map(shellQuote).join(' ')
  expect(parseShellQuoted(command)).toEqual(argv)
})

test.each(['bun x.ts', "'unterminated"])(`refuses non-canonical input %s`, (text) => {
  expect(parseShellQuoted(text)).toBeNull()
})
