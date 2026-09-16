import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { persistedRunArtifactPath, runArtifactsDir, runScratchDir } from './artifact-paths.ts'

test('persisted artifact paths follow the scratch rename and named-file copies', () => {
  const runs = join('/tmp', 'orch-runs')
  const scratch = runScratchDir(42, runs)
  const artifacts = runArtifactsDir(42, runs)
  const worktree = join('/tmp', 'orch-tree')

  expect(persistedRunArtifactPath(42, runs, join(scratch, 'reply.json'), worktree)).toBe(
    join(artifacts, 'reply.json'),
  )
  expect(persistedRunArtifactPath(42, runs, join(scratch, 'nested', 'table.json'), worktree)).toBe(
    join(artifacts, 'nested', 'table.json'),
  )
  expect(persistedRunArtifactPath(42, runs, '/tmp/elsewhere/evidence.json', worktree)).toBe(
    join(artifacts, 'evidence.json'),
  )
  expect(persistedRunArtifactPath(42, runs, 'reports/findings.json', worktree)).toBe(
    join(artifacts, 'findings.json'),
  )
})
