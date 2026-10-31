import { describe, expect, test } from 'bun:test'
import { gitPathListLiterals, gitPathListViolations } from './check-git-path-list.ts'

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
