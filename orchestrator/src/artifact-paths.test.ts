import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  isPathAtOrBelow,
  namedArtifactPlan,
  persistedRunArtifactPath,
  rewriteScratchDirPaths,
  runArtifactsDir,
  runScratchDir,
} from './artifact-paths.ts'

test('path containment accepts only the directory itself and slash descendants', () => {
  expect(isPathAtOrBelow('/runs/42/artifacts', '/runs/42/artifacts')).toBe(true)
  expect(isPathAtOrBelow('/runs/42/artifacts/report.md', '/runs/42/artifacts')).toBe(true)
  expect(isPathAtOrBelow('/runs/42/artifacts-old/report.md', '/runs/42/artifacts')).toBe(false)
})

test('named artifact plans resolve sources, destinations, and already-persisted entries', () => {
  const runs = join('/tmp', 'orch-runs')
  const scratch = runScratchDir(42, runs)
  const artifacts = runArtifactsDir(42, runs)
  const worktree = join('/tmp', 'orch-tree')

  expect(namedArtifactPlan(42, runs, join(scratch, 'nested', 'table.json'), worktree)).toEqual({
    source: join(artifacts, 'nested', 'table.json'),
    destination: join(artifacts, 'nested', 'table.json'),
    alreadyInPlace: true,
  })
  expect(namedArtifactPlan(42, runs, join(artifacts, 'report.md'), worktree)).toEqual({
    source: join(artifacts, 'report.md'),
    destination: join(artifacts, 'report.md'),
    alreadyInPlace: true,
  })
  expect(namedArtifactPlan(42, runs, 'reports/findings.json', worktree)).toEqual({
    source: join(worktree, 'reports', 'findings.json'),
    destination: join(artifacts, 'findings.json'),
    alreadyInPlace: false,
  })
})

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
  expect(
    persistedRunArtifactPath(42, runs, join(artifacts, 'nested', 'table.json'), worktree),
  ).toBe(join(artifacts, 'nested', 'table.json'))
  expect(persistedRunArtifactPath(42, runs, '/tmp/elsewhere/evidence.json', worktree)).toBe(
    join(artifacts, 'evidence.json'),
  )
  expect(persistedRunArtifactPath(42, runs, 'reports/findings.json', worktree)).toBe(
    join(artifacts, 'findings.json'),
  )
})

test('a scratch path inside a prose string field is rewritten to the artifacts path', () => {
  const runs = join('/tmp', 'orch-runs')
  const id = 11055
  const input = JSON.stringify({
    summary: `screenshot at ${join(runScratchDir(id, runs), 'header-strip.png')}`,
  })
  expect(rewriteScratchDirPaths(input, id, runs)).toBe(
    JSON.stringify({
      summary: `screenshot at ${join(runArtifactsDir(id, runs), 'header-strip.png')}`,
    }),
  )
})

test('a prefix-sharing run id and a scratchpad sibling stay untouched', () => {
  const runs = join('/tmp', 'orch-runs')
  const id = 11055
  const other = join(runScratchDir(110550, runs), 'shot.png')
  const sibling = join(runs, String(id), 'scratchpad', 'notes.md')
  const text = `${other} ${sibling}`
  expect(rewriteScratchDirPaths(text, id, runs)).toBe(text)
})

test('the bare scratch directory path is rewritten', () => {
  const runs = join('/tmp', 'orch-runs')
  const id = 11055
  expect(rewriteScratchDirPaths(runScratchDir(id, runs), id, runs)).toBe(runArtifactsDir(id, runs))
})

test('sibling scratch names stay untouched and a JSON bare scratch dir is rewritten', () => {
  const runs = join('/tmp', 'orch-runs')
  const id = 11055
  const scratch = runScratchDir(id, runs)
  const artifacts = runArtifactsDir(id, runs)
  const siblings = [
    join(runs, String(id), 'scratch+backup', 'x'),
    join(runs, String(id), 'scratch~', 'x'),
    join(runs, String(id), 'scratch@old', 'x'),
    join(runs, String(id), 'scratch (copy)', 'x'),
  ].join(' ')
  expect(rewriteScratchDirPaths(siblings, id, runs)).toBe(siblings)
  expect(rewriteScratchDirPaths(JSON.stringify({ dir: scratch }), id, runs)).toBe(
    JSON.stringify({ dir: artifacts }),
  )
})
