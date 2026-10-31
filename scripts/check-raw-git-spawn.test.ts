import { describe, expect, test } from 'bun:test'
import { rawGitSpawns, rawGitSpawnViolations } from './check-raw-git-spawn.ts'

describe('raw git spawn check', () => {
  test('finds direct git spawns in production files and excludes tests, fixtures, and helpers', () => {
    const source = `const result = Bun.${'spawnSync'}(['git', 'status'])`
    expect(
      rawGitSpawns({
        'orchestrator/src/example.ts': source,
        'hub/src/example.ts': `\n${source}`,
        'shared/example.test.ts': source,
        'shared/fixtures/example.ts': source,
        'shared/test-git-repository.ts': source,
        'orchestrator/src/git/git-environment.ts': source,
        'shared/git.ts': source,
      }),
    ).toEqual([
      { file: 'hub/src/example.ts', line: 2 },
      { file: 'orchestrator/src/example.ts', line: 1 },
    ])
  })

  test('refuses growth at its line with the guarded-helper remedy', () => {
    const findings = rawGitSpawns({
      'orchestrator/src/example.ts': [
        `Bun.${'spawn'}(['git', 'status'])`,
        `Bun.${'spawnSync'}(['git', 'log'])`,
      ].join('\n'),
    })
    expect(
      rawGitSpawnViolations(findings, { files: { 'orchestrator/src/example.ts': 1 } }),
    ).toEqual([
      'orchestrator/src/example.ts:2: raw git spawn is not guarded; use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts',
    ])
  })

  test('requires a lowered baseline after a raw spawn is removed', () => {
    expect(rawGitSpawnViolations([], { files: { 'shared/change-view.ts': 1 } })).toEqual([
      'shared/change-view.ts: raw git spawn baseline may only shrink; lower its count from 1 to 0',
    ])
  })
})
