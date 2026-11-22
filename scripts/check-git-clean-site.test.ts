import { expect, test } from 'bun:test'
import { checkGitCleanSites, scanGitCleanSites } from './check-git-clean-site.ts'

test('git clean is allowed only in the run-tree helper', () => {
  expect(
    scanGitCleanSites({
      'orchestrator/src/example.ts': [
        `git(['clean', '-fdx'])`,
        `command(path, ['git', 'clean', '-fdx'])`,
        `command(path, ['git', '-C', path, 'clean', '-fdx'])`,
      ].join('\n'),
      'orchestrator/src/worktree/worktree-attribution.ts': [
        `export function cleanRunTree(path: string) { git(['clean', '-fdx'], path) }`,
        `export function other(path: string) { git(['clean', '-fdx'], path) }`,
      ].join('\n'),
    }),
  ).toEqual({
    findings: [
      { file: 'orchestrator/src/example.ts', line: 1 },
      { file: 'orchestrator/src/example.ts', line: 2 },
      { file: 'orchestrator/src/example.ts', line: 3 },
      { file: 'orchestrator/src/worktree/worktree-attribution.ts', line: 2 },
    ],
    filesScanned: 2,
    exemptSites: 1,
  })
})

test('successful output reports files scanned and exempt helper sites', () => {
  const messages: string[] = []
  expect(
    checkGitCleanSites(
      {
        'orchestrator/src/example.ts': `git(['status'])`,
        'orchestrator/src/worktree/worktree-attribution.ts': `export function cleanRunTree(path: string) { git(['clean', '-fdx'], path) }`,
      },
      { error: () => undefined, log: (message) => messages.push(message) },
    ),
  ).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('2 files scanned, 1 exempt cleanRunTree sites')
})
