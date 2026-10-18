import { describe, expect, test } from 'bun:test'
import { RUN_ARTIFACT_FILE_CAP_BYTES, RUN_ARTIFACT_TOTAL_CAP_BYTES } from './run-artifact-limits.ts'
import {
  decideRunArtifactRetention,
  type RunArtifactListingEntry,
} from './run-artifact-retention.ts'

const file = (path: string, size = 1): RunArtifactListingEntry => ({ path, kind: 'file', size })
const directory = (path: string): RunArtifactListingEntry => ({ path, kind: 'directory', size: 0 })

describe('finished run artifact retention', () => {
  test('drops repository and dependency copies as bounded directory records', () => {
    const plan = decideRunArtifactRetention(
      [
        directory('repo'),
        directory('repo/.git'),
        file('repo/report.md', 7),
        directory('node_modules'),
        file('node_modules/pkg/index.js', 9),
      ],
      ['repo/report.md'],
    )
    expect(plan.kept).toEqual([])
    expect(plan.dropped).toEqual([
      { path: 'node_modules', size: 9, reason: 'dependency', fileCount: 1 },
      { path: 'repo', size: 7, reason: 'copy', fileCount: 1 },
    ])
  })

  test('drops an ordinary oversized file but keeps a reply-named large file', () => {
    const large = RUN_ARTIFACT_FILE_CAP_BYTES + 1
    const plan = decideRunArtifactRetention(
      [file('large.log', large), file('named.log', large)],
      ['named.log'],
    )
    expect(plan.kept).toEqual(['named.log'])
    expect(plan.dropped).toContainEqual({
      path: 'large.log',
      size: large,
      reason: 'over the per-file cap',
    })
  })

  test('reserves the total cap for the diff, named files, then lexical shallow files', () => {
    const plan = decideRunArtifactRetention(
      [
        file('z.txt'),
        file('named.bin', RUN_ARTIFACT_FILE_CAP_BYTES),
        file('a.txt'),
        file('worktree.diff', RUN_ARTIFACT_TOTAL_CAP_BYTES - RUN_ARTIFACT_FILE_CAP_BYTES),
      ],
      ['named.bin'],
    )
    expect(plan.kept).toEqual(['worktree.diff', 'named.bin'])
    expect(
      plan.dropped
        .filter((entry) => entry.reason === 'over the total cap')
        .map((entry) => entry.path),
    ).toEqual(['a.txt', 'z.txt'])
  })

  test('keeps an over-total diff and drops everything after it', () => {
    const size = RUN_ARTIFACT_TOTAL_CAP_BYTES + 1
    const plan = decideRunArtifactRetention(
      [file('worktree.diff', size), file('named.txt')],
      ['named.txt'],
    )
    expect(plan.kept).toEqual(['worktree.diff'])
    expect(plan.dropped).toContainEqual({
      path: 'named.txt',
      size: 1,
      reason: 'over the total cap',
    })
  })
})
