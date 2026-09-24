import { describe, expect, test } from 'bun:test'
import { reviewCoverageVerdict } from './review-coverage.ts'
import type { CoverageGitResult, CoverageGitRunner, ReviewCoverageInput } from './review-types.ts'

const review: ReviewCoverageInput = {
  id: 1,
  lenses: [
    {
      lens: 'test',
      tree: 'reviewed-tree',
      inputTree: 'reviewed-tree',
      branch: 'DEV-909-test',
      baseCommit: 'base-commit',
      launchCwd: null,
      headCommit: 'reviewed-commit',
    },
  ],
}

function result(ok: boolean, out = '', err = ''): CoverageGitResult {
  return { ok, out, err, stdout: new Uint8Array() }
}

describe('review coverage', () => {
  test('executes against the selected trunk ref but reports the configured trunk', () => {
    const verdictFor = (remoteTrackingRefExists: boolean) => {
      const calls: string[][] = []
      const runner: CoverageGitRunner = (args) => {
        calls.push(args)
        const command = args.join(' ')
        if (command === 'rev-parse tip^{tree}') return result(true, 'tip-tree')
        if (command === 'cat-file -e reviewed-commit^{commit}') return result(true)
        if (command === 'rev-parse reviewed-commit^{tree}') return result(true, 'reviewed-tree')
        if (command === 'cat-file -e base-commit^{commit}') return result(true)
        if (command === 'merge-base reviewed-commit base-commit') return result(true, 'old-base')
        if (command === 'show-ref --verify --quiet refs/remotes/origin/main') {
          return result(remoteTrackingRefExists)
        }
        if (command === `merge-base tip ${remoteTrackingRefExists ? 'origin/main' : 'main'}`) {
          return result(false, '', 'no merge base')
        }
        throw new Error(`unexpected git call: ${command}`)
      }
      return {
        calls,
        verdict: reviewCoverageVerdict('/unused', review, 'tip', 'main', runner, {
          skipExact: true,
        }),
      }
    }

    const withRemote = verdictFor(true)
    expect(withRemote.calls).toContainEqual(['merge-base', 'tip', 'origin/main'])
    expect(withRemote.verdict).toEqual({
      kind: 'invalid',
      reason: 'git merge-base tip main failed: no merge base',
      resolution: 'pin',
    })

    const withoutRemote = verdictFor(false)
    expect(withoutRemote.calls).toContainEqual(['merge-base', 'tip', 'main'])
    expect(withoutRemote.verdict).toEqual({
      kind: 'invalid',
      reason: 'git merge-base tip main failed: no merge base',
      resolution: 'pin',
    })
  })
})
