import { describe, expect, test } from 'bun:test'
import { phpcsFindings, phpstanFindings } from './php-report-adapters.ts'

const root = '/container/project'
const phpcs = (messages: unknown[], file = `${root}/src/Example.php`) =>
  JSON.stringify({ files: { [file]: { messages } } })
const phpstan = (messages: unknown[], file = `${root}/src/Example.php`) =>
  JSON.stringify({ files: { [file]: { messages } } })

describe('PHP report adapters', () => {
  test('PHPCS reads errors, omits warnings, and makes rooted paths relative', () => {
    expect(
      phpcsFindings(
        phpcs([
          { line: 4, source: 'Rule.Error', message: 'Broken.', type: 'ERROR' },
          { line: 5, source: 'Rule.Warning', message: 'Advisory.', type: 'WARNING' },
        ]),
        { reportRoot: root },
      ),
    ).toEqual([{ file: 'src/Example.php', line: 4, rule: 'Rule.Error', message: 'Broken.' }])
  })

  test('PHPStan reads every message and gives unidentified messages the fixed rule', () => {
    expect(
      phpstanFindings(
        phpstan([
          { line: 8, identifier: 'argument.type', message: 'Wrong type.' },
          { line: 9, message: 'General failure.' },
        ]),
        { reportRoot: root },
      ),
    ).toEqual([
      { file: 'src/Example.php', line: 8, rule: 'argument.type', message: 'Wrong type.' },
      { file: 'src/Example.php', line: 9, rule: 'phpstan', message: 'General failure.' },
    ])
  })

  test('PHPStan accepts an empty files array and uses line zero for unlocated messages', () => {
    expect(phpstanFindings(JSON.stringify({ files: [] }), { reportRoot: root })).toEqual([])
    expect(
      phpstanFindings(
        phpstan([{ line: null, identifier: 'phpstan.path', message: 'Path is not a file.' }]),
        { reportRoot: root },
      ),
    ).toEqual([
      {
        file: 'src/Example.php',
        line: 0,
        rule: 'phpstan.path',
        message: 'Path is not a file.',
      },
    ])
  })

  test('keeps relative paths and refuses absolute paths outside the report root', () => {
    expect(
      phpcsFindings(
        phpcs([{ line: 1, source: 'Rule', message: 'Broken.', type: 'ERROR' }], 'src/A.php'),
        { reportRoot: root },
      )[0]?.file,
    ).toBe('src/A.php')
    expect(() =>
      phpstanFindings(
        phpstan([{ line: 1, identifier: 'rule', message: 'Broken.' }], '/else/A.php'),
        {
          reportRoot: root,
        },
      ),
    ).toThrow('report path is outside report root')
  })

  test('refuses unparseable text and reports without a files object', () => {
    expect(() => phpcsFindings('not json', { reportRoot: root })).toThrow('invalid PHPCS JSON')
    expect(() => phpstanFindings('{}', { reportRoot: root })).toThrow(
      'PHPStan report has no files object',
    )
  })

  test('extracts a measure with the caller-declared pattern', () => {
    const rule = 'Project.Custom.Rule'
    const message = 'reported value is 51'
    expect(
      phpcsFindings(phpcs([{ line: 1, source: rule, message, type: 'ERROR' }]), {
        reportRoot: root,
        measures: [{ rule, pattern: 'value is (\\d+)' }],
      })[0]?.measure,
    ).toBe(51)
  })

  test('refuses a measure pattern with two groups and a nonnumeric capture', () => {
    const report = phpcs([{ line: 1, source: 'Rule', message: 'using 51 of 50', type: 'ERROR' }])
    expect(() =>
      phpcsFindings(report, {
        reportRoot: root,
        measures: [{ rule: 'Rule', pattern: 'using (\\d+) of (\\d+)' }],
      }),
    ).toThrow('must have exactly one capture group')
    expect(() =>
      phpcsFindings(phpcs([{ line: 1, source: 'Rule', message: 'value many', type: 'ERROR' }]), {
        reportRoot: root,
        measures: [{ rule: 'Rule', pattern: 'value (\\w+)' }],
      }),
    ).toThrow('did not capture a number from message: value many')
  })
})
