import { describe, expect, test } from 'bun:test'
import { biomeFindings } from './biome-adapter.ts'

const output = (diagnostics: unknown[]) =>
  JSON.stringify({ summary: {}, diagnostics, command: 'lint' })
const diagnostic = (category: string, message: string) => ({
  category,
  message,
  location: { path: 'src/example.ts', start: { line: 7, column: 3 } },
})

describe('Biome finding adapter', () => {
  test('reads a plain finding', () => {
    expect(
      biomeFindings(output([diagnostic('lint/style/useNamingConvention', 'Use camelCase.')])),
    ).toEqual([
      {
        file: 'src/example.ts',
        line: 7,
        rule: 'lint/style/useNamingConvention',
        message: 'Use camelCase.',
      },
    ])
  })

  test('reads the function line measure', () => {
    expect(
      biomeFindings(
        output([
          diagnostic(
            'lint/complexity/noExcessiveLinesPerFunction',
            'This function has too many lines (91). Maximum allowed is 80.',
          ),
        ]),
      )[0]?.measure,
    ).toBe(91)
  })

  test('refuses unparseable output and a measured diagnostic without its number', () => {
    expect(() => biomeFindings('not json')).toThrow('invalid JSON')
    expect(() =>
      biomeFindings(
        output([
          diagnostic(
            'lint/complexity/noExcessiveLinesPerFunction',
            'This function exceeds the limit.',
          ),
        ]),
      ),
    ).toThrow('carries no measure')
  })
})
