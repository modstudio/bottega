import { describe, expect, test } from 'bun:test'
import type { ChangeEntry, ContentResult } from '../../../shared/change-view.ts'
import { commandForSide, sideFiles, supportPlacements } from './ratchet-plan.ts'

test('command templating expands files and the checkout root', () => {
  expect(
    commandForSide(['lint', '--config={root}/config', '{files}'], ['a.ts', 'b.ts'], '/repo'),
  ).toEqual(['lint', '--config=/repo/config', 'a.ts', 'b.ts'])
})

test('support paths keep their relative locations in a mirror', () => {
  expect(supportPlacements('/repo', '/tmp/side', ['biome.jsonc', 'lint/plugins'])).toEqual([
    { source: '/repo/biome.jsonc', destination: '/tmp/side/biome.jsonc' },
    { source: '/repo/lint/plugins', destination: '/tmp/side/lint/plugins' },
  ])
})

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
