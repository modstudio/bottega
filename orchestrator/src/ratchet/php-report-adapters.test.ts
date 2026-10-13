import { describe, expect, test } from 'bun:test'
import { ratchetDecision } from '../../../shared/ratchet.ts'
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

  test.each([
    [
      'SlevomatCodingStandard.Functions.FunctionLength.FunctionLength',
      'Your function is too long. Currently using 51 lines. Can be up to 50 lines.',
      'using (\\d+) lines',
      51,
    ],
    [
      'SlevomatCodingStandard.Files.FileLength.FileTooLong',
      'Your file is too long. Currently using 301 lines. Can be up to 300 lines.',
      'using (\\d+) lines',
      301,
    ],
    [
      'SlevomatCodingStandard.Complexity.Cognitive.Complexity',
      'Cognitive complexity for "handle" is 12 but has to be less than or equal to 10.',
      'is (\\d+) but',
      12,
    ],
    [
      'Generic.Files.LineLength.MaxExceeded',
      'Line exceeds maximum limit of 170 characters; contains 171 characters',
      'contains (\\d+) characters',
      171,
    ],
  ])('extracts the declared measure for %s', (rule, message, pattern, expected) => {
    expect(
      phpcsFindings(phpcs([{ line: 1, source: rule, message, type: 'ERROR' }]), {
        reportRoot: root,
        measures: [{ rule, pattern }],
      })[0]?.measure,
    ).toBe(expected)
  })

  test('refuses a measure pattern without one group and a nonnumeric capture', () => {
    const report = phpcs([{ line: 1, source: 'Rule', message: 'value many', type: 'ERROR' }])
    expect(() =>
      phpcsFindings(report, { reportRoot: root, measures: [{ rule: 'Rule', pattern: '\\d+' }] }),
    ).toThrow('must have exactly one capture group')
    expect(() =>
      phpcsFindings(report, {
        reportRoot: root,
        measures: [{ rule: 'Rule', pattern: 'value (\\w+)' }],
      }),
    ).toThrow('did not capture a number from message: value many')
  })

  test('maps either renamed base path to the old path', () => {
    const options = {
      reportRoot: root,
      baseRenames: new Map([['src/New.php', 'src/Old.php']]),
    }
    const message = [{ line: 2, source: 'Rule', message: 'Broken.', type: 'ERROR' }]
    expect(phpcsFindings(phpcs(message, `${root}/src/New.php`), options)[0]?.file).toBe(
      'src/Old.php',
    )
    expect(phpcsFindings(phpcs(message, `${root}/src/Old.php`), options)[0]?.file).toBe(
      'src/Old.php',
    )
  })

  test('the decision permits a shortened measured finding and refuses one that grew', () => {
    const base = [
      { file: 'src/A.php', line: 10, rule: 'length', message: 'length 81', measure: 81 },
    ]
    const change = { renames: new Map(), addedLines: new Map() }
    expect(
      ratchetDecision({
        base,
        head: [{ file: 'src/A.php', line: 10, rule: 'length', message: 'length 65', measure: 65 }],
        change,
      }),
    ).toEqual([])
    expect(
      ratchetDecision({
        base,
        head: [{ file: 'src/A.php', line: 10, rule: 'length', message: 'length 90', measure: 90 }],
        change,
      })[0],
    ).toMatchObject({ reason: 'grew', previousMeasure: 81 })
  })

  test('the decision refuses an added-line finding without blaming old findings elsewhere', () => {
    const oldFinding = { file: 'src/A.php', line: 2, rule: 'rule', message: 'old finding' }
    const base = Array.from({ length: 10 }, () => oldFinding)
    const head = base.map((finding, index) => ({ ...finding, line: index + 20 }))
    const unchanged = ratchetDecision({
      base,
      head,
      change: { renames: new Map(), addedLines: new Map([['src/A.php', [{ start: 5, end: 5 }]]]) },
    })
    expect(unchanged).toEqual([])
    expect(
      ratchetDecision({
        base,
        head: [...head, { file: 'src/A.php', line: 5, rule: 'new', message: 'new finding' }],
        change: {
          renames: new Map(),
          addedLines: new Map([['src/A.php', [{ start: 5, end: 5 }]]]),
        },
      }).at(-1),
    ).toMatchObject({ reason: 'added-line' })
  })

  test.each([`${root}/src/Old.php`, `${root}/src/New.php`])(
    'the decision keeps a rename allowance when the base report names %s',
    (basePath) => {
      const base = phpcsFindings(
        phpcs([{ line: 3, source: 'Rule', message: 'Old debt.', type: 'ERROR' }], basePath),
        {
          reportRoot: root,
          baseRenames: new Map([['src/New.php', 'src/Old.php']]),
        },
      )
      expect(
        ratchetDecision({
          base,
          head: [{ file: 'src/New.php', line: 3, rule: 'Rule', message: 'Old debt.' }],
          change: {
            renames: new Map([['src/New.php', 'src/Old.php']]),
            addedLines: new Map(),
          },
        }),
      ).toEqual([])
    },
  )
})
