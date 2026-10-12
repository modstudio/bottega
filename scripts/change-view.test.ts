import { describe, expect, test } from 'bun:test'
import {
  changeFacts,
  changeViewPlan,
  parseAddedLines,
  parseNameStatus,
  untrackedChanges,
} from './change-view'

describe('changeViewPlan', () => {
  test('worktree mode compares the base with the files on disk and lists untracked files', () => {
    const plan = changeViewPlan('abc123', 'worktree')
    expect(plan.nameStatus.at(-1)).toBe('abc123')
    expect(plan.patch.at(-1)).toBe('abc123')
    expect([...plan.nameStatus, ...plan.patch]).not.toContain('HEAD')
    expect([...plan.nameStatus, ...plan.patch]).not.toContain('--cached')
    expect(plan.untracked).toEqual(['ls-files', '--others', '--exclude-standard', '-z'])
    expect(plan.head).toBe('working-tree')
  })

  test('staged mode compares the base with the index and reads no untracked file', () => {
    const plan = changeViewPlan('HEAD', 'staged')
    expect(plan.nameStatus.slice(-2)).toEqual(['--cached', 'HEAD'])
    expect(plan.patch.slice(-2)).toEqual(['--cached', 'HEAD'])
    expect(plan.untracked).toBeNull()
    expect(plan.head).toBe('index')
  })
})

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

describe('untrackedChanges', () => {
  test('turns zero-delimited paths and supplied line counts into additions', () => {
    expect(
      untrackedChanges(
        ['new source.ts', 'empty.ts', 'nested/other.ts', ''].join('\0'),
        new Map([
          ['new source.ts', 4],
          ['empty.ts', 0],
          ['nested/other.ts', 2],
        ]),
      ),
    ).toEqual({
      entries: [
        { status: 'A', path: 'new source.ts' },
        { status: 'A', path: 'empty.ts' },
        { status: 'A', path: 'nested/other.ts' },
      ],
      addedLines: new Map([
        ['new source.ts', [{ start: 1, end: 4 }]],
        ['nested/other.ts', [{ start: 1, end: 2 }]],
      ]),
    })
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
