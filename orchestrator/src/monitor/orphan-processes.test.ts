import { describe, expect, test } from 'bun:test'
import { orphanProcesses } from '../resources/process-inventory.ts'

describe('orphan worktree process policy', () => {
  const project = { name: 'app', path: '/code/app' }
  test('finds a missing tree from cwd or an absolute argument', () => {
    const facts = [
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        command: 'vite',
        ageSeconds: 5,
        startTime: 'birth',
        cwd: '/code/app/.claude/worktrees/gone/web',
        cwdVerified: true,
      },
      {
        pid: 11,
        ppid: 1,
        pgid: 11,
        command: 'tool --root=/code/app/.claude/worktrees/also-gone/file',
        ageSeconds: 6,
        startTime: 'birth',
        cwd: '/tmp',
        cwdVerified: true,
      },
    ]
    expect(orphanProcesses(facts, [project], () => false).map((item) => item.missingTree)).toEqual([
      '/code/app/.claude/worktrees/gone',
      '/code/app/.claude/worktrees/also-gone',
    ])
  })
  test('keeps processes for existing trees and paths outside registered roots', () => {
    const facts = [
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        command: 'vite /tmp/file',
        ageSeconds: 5,
        startTime: 'birth',
        cwd: '/code/app/.claude/worktrees/live',
        cwdVerified: true,
      },
    ]
    expect(orphanProcesses(facts, [project], (path) => path.endsWith('/live'))).toEqual([])
  })

  test('keeps an orphan visible when its cwd birth cannot be verified', () => {
    const [orphan] = orphanProcesses(
      [
        {
          pid: 10,
          ppid: 1,
          pgid: 10,
          command: 'vite',
          ageSeconds: 5,
          startTime: 'birth',
          cwd: '/code/app/.claude/worktrees/gone/web',
          cwdVerified: false,
        },
      ],
      [project],
      () => false,
    )
    expect(orphan).toMatchObject({ pid: 10, match: 'cwd', cwdVerified: false })
  })
})
