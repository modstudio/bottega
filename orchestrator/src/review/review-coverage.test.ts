import { describe, expect, test } from 'bun:test'
import { reviewCoverageVerdict } from './review-coverage.ts'
import type { CoverageGitResult, CoverageGitRunner, ReviewCoverageInput } from './review-types.ts'

const review: ReviewCoverageInput = {
  recordId: 'review-1',
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
      const runner: CoverageGitRunner = (args) => {
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
        verdict: reviewCoverageVerdict('/unused', review, 'tip', 'main', runner, {
          skipExact: true,
        }),
      }
    }

    const withRemote = verdictFor(true)
    expect(withRemote.verdict).toEqual({
      kind: 'invalid',
      reason: 'git merge-base tip main failed: no merge base',
      resolution: 'pin',
    })

    const withoutRemote = verdictFor(false)
    expect(withoutRemote.verdict).toEqual({
      kind: 'invalid',
      reason: 'git merge-base tip main failed: no merge base',
      resolution: 'pin',
    })
  })

  test('carries an unchanged patch when trunk touched the same path', () => {
    const calls: string[][] = []
    const runner: CoverageGitRunner = (args) => {
      calls.push(args)
      const command = args.join(' ')
      if (command === 'rev-parse tip^{tree}') return result(true, 'tip-tree')
      if (command === 'cat-file -e reviewed-commit^{commit}') return result(true)
      if (command === 'rev-parse reviewed-commit^{tree}') return result(true, 'reviewed-tree')
      if (command === 'cat-file -e base-commit^{commit}') return result(true)
      if (command === 'merge-base reviewed-commit base-commit') return result(true, 'old-base')
      if (command === 'show-ref --verify --quiet refs/remotes/origin/main') return result(false)
      if (command === 'merge-base tip main') return result(true, 'new-base')
      if (command === 'diff --name-only old-base..reviewed-commit -z') {
        return result(true, 'src/shared.ts\0')
      }
      if (command === 'diff --binary --no-ext-diff --no-color new-base..tip') {
        return {
          ...result(true),
          stdout: new TextEncoder().encode('unchanged branch patch'),
        }
      }
      if (command === 'patch-id --stable') return result(true, 'patch-a tip')
      if (command === 'diff --name-only new-base..tip -z') {
        return result(true, 'src/shared.ts\0')
      }
      if (command === 'log --format=%B new-base..tip') return result(true, 'rebased change')
      throw new Error(`unexpected git call: ${command}`)
    }

    expect(
      reviewCoverageVerdict(
        '/unused',
        { ...review, patchId: 'patch-a', pathSet: '["src/shared.ts"]' },
        'tip',
        'main',
        runner,
        { skipExact: true },
      ),
    ).toMatchObject({ kind: 'carried', class: 'trivial-rebase', patchId: 'patch-a' })
    expect(calls).not.toContainEqual(['diff', '--name-only', 'old-base..new-base', '-z'])
  })
})
