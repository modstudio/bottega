import { describe, expect, test } from 'bun:test'
import {
  gitEnvironmentViolations,
  gitSpawns,
  rawGitSpawnViolations,
} from './check-git-environment-spawn.ts'

describe('git spawn check', () => {
  test('finds direct git spawns in production files and excludes raw-count fixtures and helpers', () => {
    const source = `const result = Bun.${'spawnSync'}(['git', 'status'], { env })`
    const findings = gitSpawns({
      'orchestrator/src/example.ts': source,
      'hub/src/example.ts': `\n${source}`,
      'shared/example.test.ts': source,
      'shared/fixtures/example.ts': source,
      'shared/test-git-repository.ts': source,
      'orchestrator/src/git/git-environment.ts': source,
      'shared/git.ts': source,
    })
    expect(
      findings
        .filter((finding) => finding.countsTowardBaseline)
        .map(({ file, line }) => `${file}:${line}`)
        .sort(),
    ).toEqual(
      ['hub/src/example.ts:2', 'orchestrator/src/example.ts:1'].sort(),
    )
  })

  test('keeps the scrubbed-environment rule on the shared matcher', () => {
    const findings = gitSpawns({
      'hub/src/missing.ts': `Bun.${'spawn'}(['git', 'status'])`,
      'hub/src/raw.ts': `Bun.${'spawnSync'}(['git'], { env: process.env })`,
      'hub/src/scrubbed.ts': `Bun.${'spawn'}(['git'], { env })`,
    })
    expect(gitEnvironmentViolations(findings).sort()).toEqual(
      [
        'hub/src/missing.ts:1: production git spawn must supply a scrubbed environment',
        'hub/src/raw.ts:1: production git spawn must supply a scrubbed environment',
      ].sort(),
    )
  })

  test('refuses growth at its line with the guarded-helper remedy', () => {
    const findings = gitSpawns({
      'orchestrator/src/example.ts': [
        `Bun.${'spawn'}(['git', 'status'])`,
        `Bun.${'spawnSync'}(['git', 'log'])`,
      ].join('\n'),
    })
    expect(
      rawGitSpawnViolations(
        findings.filter((finding) => finding.countsTowardBaseline),
        { files: { 'orchestrator/src/example.ts': 1 } },
      ),
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
