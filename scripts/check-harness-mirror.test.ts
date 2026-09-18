import { describe, expect, test } from 'bun:test'
import { decideHarnessMirror } from './check-harness-mirror.ts'

describe('harness mirror decision', () => {
  test('rejects a real skills directory', () => {
    expect(decideHarnessMirror([{ path: '.claude/skills', isSymlink: false }])).toEqual([
      '.claude/skills: move it under .agents/ and symlink .claude/skills to ../.agents/skills',
    ])
  })

  test('rejects a symlink to the wrong target', () => {
    expect(
      decideHarnessMirror([{ path: '.claude/rules', isSymlink: true, target: '../other/rules' }]),
    ).toEqual([
      '.claude/rules: move it under .agents/ and symlink .claude/rules to ../.agents/rules',
    ])
  })

  test('allows settings and matching agent symlinks', () => {
    expect(
      decideHarnessMirror([
        { path: '.claude/settings.json', isSymlink: false },
        { path: '.claude/rules', isSymlink: true, target: '../.agents/rules' },
        { path: '.claude/skills', isSymlink: true, target: '../.agents/skills' },
      ]),
    ).toEqual([])
  })
})
