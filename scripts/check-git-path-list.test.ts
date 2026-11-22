import { describe, expect, test } from 'bun:test'
import {
  gitCleanLiterals,
  gitPathListLiterals,
  gitPathListViolations,
} from './check-git-path-list.ts'

describe('git path-list check', () => {
  test('counts a bare literal but not a helper argument', () => {
    const findings = gitPathListLiterals({
      'scripts/example.ts': [
        `run(['git', 'diff', '--name-only'])`,
        `run(nulPathListArgs(['git', 'ls-files']))`,
      ].join('\n'),
    })
    expect(findings).toEqual([{ file: 'scripts/example.ts', line: 1 }])
  })

  test('refuses a file over its baseline', () => {
    const findings = gitPathListLiterals({
      'orchestrator/src/example.ts': [`git(['diff', '--name-status'])`, `git(['diff-tree'])`].join(
        '\n',
      ),
    })
    expect(
      gitPathListViolations(findings, { files: { 'orchestrator/src/example.ts': 1 } }),
    ).toEqual([
      'orchestrator/src/example.ts:2: raw git path list; build the arguments with nulPathListArgs and parse with splitNulPaths or splitNulNameStatus from shared/git-path-list.ts',
    ])
  })
})

test('git clean is allowed only in the run-tree helper', () => {
  expect(
    gitCleanLiterals({
      'orchestrator/src/example.ts': [
        `git(['clean', '-fdx'])`,
        `command(path, ['git', 'clean', '-fdx'])`,
      ].join('\n'),
      'orchestrator/src/worktree/worktree-attribution.ts': [
        `export function cleanRunTree(path: string) { git(['clean', '-fdx'], path) }`,
        `export function other(path: string) { git(['clean', '-fdx'], path) }`,
      ].join('\n'),
    }),
  ).toEqual([
    { file: 'orchestrator/src/example.ts', line: 1 },
    { file: 'orchestrator/src/example.ts', line: 2 },
    { file: 'orchestrator/src/worktree/worktree-attribution.ts', line: 2 },
  ])
})
