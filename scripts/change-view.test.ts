import { describe, expect, test } from 'bun:test'
import { changeFacts, parseAddedLines, parseNameStatus } from './change-view'

describe('parseNameStatus', () => {
  test('parses zero-delimited statuses without changing unusual paths', () => {
    const text = [
      'A',
      'space name.ts',
      'M',
      'tab\tname.ts',
      'D',
      'quote"name.ts',
      'R087',
      'old-λ.ts',
      'new-λ.ts',
      'C100',
      'source.ts',
      'copy.ts',
      '',
    ].join('\0')

    expect(parseNameStatus(text)).toEqual([
      { status: 'A', path: 'space name.ts' },
      { status: 'M', path: 'tab\tname.ts' },
      { status: 'D', path: 'quote"name.ts' },
      { status: 'R', sourcePath: 'old-λ.ts', path: 'new-λ.ts' },
      { status: 'C', sourcePath: 'source.ts', path: 'copy.ts' },
    ])
  })
})

describe('parseAddedLines', () => {
  test('records inclusive head ranges and ignores hunks with no additions', () => {
    const patch = [
      'diff --git a/source.ts b/source.ts',
      'index 1111111..2222222 100644',
      '--- a/source.ts',
      '+++ b/source.ts',
      '@@ -2,0 +3,2 @@ first',
      '+one',
      '+two',
      '@@ -10 +11,0 @@ deletion',
      '-gone',
      '@@ -20 +20 @@ replacement',
      '-old',
      '+new',
      '',
    ].join('\n')

    expect(parseAddedLines(patch)).toEqual(
      new Map([
        [
          'source.ts',
          [
            { start: 3, end: 4 },
            { start: 20, end: 20 },
          ],
        ],
      ]),
    )
  })

  test('does not record a deleted file', () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '',
    ].join('\n')

    expect(parseAddedLines(patch)).toEqual(new Map())
  })

  test('records every line in a new file', () => {
    const patch = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
      '',
    ].join('\n')

    expect(parseAddedLines(patch)).toEqual(new Map([['new.ts', [{ start: 1, end: 3 }]]]))
  })

  test('decodes git quoted patch paths', () => {
    const patch = [
      'diff --git "a/tab\\tλ😀.ts" "b/tab\\tλ😀.ts"',
      '--- "a/tab\\tλ😀.ts"',
      '+++ "b/tab\\tλ😀.ts"',
      '@@ -0,0 +1 @@',
      '+new',
      '',
    ].join('\n')

    expect(parseAddedLines(patch)).toEqual(new Map([['tab\tλ😀.ts', [{ start: 1, end: 1 }]]]))
  })
})

describe('changeFacts', () => {
  test('builds rename facts from renames only and preserves added ranges', () => {
    const addedLines = new Map([['renamed.ts', [{ start: 5, end: 7 }]]])
    expect(
      changeFacts(
        [
          { status: 'R', sourcePath: 'old.ts', path: 'renamed.ts' },
          { status: 'C', sourcePath: 'source.ts', path: 'copied.ts' },
          { status: 'M', path: 'changed.ts' },
        ],
        addedLines,
      ),
    ).toEqual({ renames: new Map([['renamed.ts', 'old.ts']]), addedLines })
  })
})
