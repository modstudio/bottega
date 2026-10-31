import { describe, expect, test } from 'bun:test'
import { nulPathListArgs, splitNulNameStatus, splitNulPaths } from './git-path-list.ts'

describe('git path lists', () => {
  test('preserves paths byte-for-byte as text', () => {
    expect(splitNulPaths('storage/app/WordBankTextFiles/Nevi’im/a.json\0say "hi".txt\0')).toEqual([
      'storage/app/WordBankTextFiles/Nevi’im/a.json',
      'say "hi".txt',
    ])
  })

  test('pairs rename and ordinary name-status entries', () => {
    expect(splitNulNameStatus('R100\0old\0new\0M\0x’y\0')).toEqual([
      { status: 'R100', previousPath: 'old', path: 'new' },
      { status: 'M', previousPath: null, path: 'x’y' },
    ])
  })

  test('adds one NUL flag before the pathspec separator', () => {
    expect(nulPathListArgs(['diff', '--name-only', '--', 'path'])).toEqual([
      'diff',
      '--name-only',
      '-z',
      '--',
      'path',
    ])
    expect(nulPathListArgs(['ls-files', '-z'])).toEqual(['ls-files', '-z'])
  })
})
