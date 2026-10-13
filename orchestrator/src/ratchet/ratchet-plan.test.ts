import { describe, expect, test } from 'bun:test'
import type { ChangeEntry, ContentResult } from '../../../shared/change-view.ts'
import { sideFiles } from './ratchet-plan.ts'

describe('side files', () => {
  const entries: ChangeEntry[] = [
    { status: 'A', path: 'added.ts' },
    { status: 'D', path: 'deleted.ts' },
    { status: 'R', sourcePath: 'old.ts', path: 'renamed.ts' },
    { status: 'M', path: 'modified.ts' },
  ]
  const present = (path: string): ContentResult => ({ status: 'present', text: path })

  test('head receives added, renamed, and modified paths', () => {
    expect(sideFiles(entries, 'head', present).map(({ path }) => path)).toEqual([
      'added.ts',
      'renamed.ts',
      'modified.ts',
    ])
  })

  test('base receives deleted, rename-source, and modified paths', () => {
    expect(sideFiles(entries, 'base', present).map(({ path }) => path)).toEqual([
      'deleted.ts',
      'old.ts',
      'modified.ts',
    ])
  })
})
