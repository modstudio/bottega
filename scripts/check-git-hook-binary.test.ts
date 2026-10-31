import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { gitHookBinaryViolations } from './check-git-hook-binary.ts'

const assignment = `common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}`

describe('gitHookBinaryViolations', () => {
  test('accepts a hook that invokes the main checkout binary', () => {
    expect(
      gitHookBinaryViolations(
        '.githooks/pre-push',
        `${assignment}
"$main_checkout/bin/${PLATFORM_SLUG}" pr check`,
      ),
    ).toEqual([])
  })

  test('names the line that invokes a worktree binary', () => {
    expect(
      gitHookBinaryViolations(
        '.githooks/pre-push',
        `${assignment}
echo checking
"$root/bin/${PLATFORM_SLUG}" pr check`,
      ),
    ).toEqual([
      ".githooks/pre-push:4: a tracked git hook runs the main checkout's binary, because a tree's binary can carry a journal ahead of the operator store",
    ])
  })

  test('requires a common directory assignment when the hook names the binary', () => {
    expect(
      gitHookBinaryViolations(
        '.githooks/post-merge',
        `main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}
"$main_checkout/bin/${PLATFORM_SLUG}" machine migrate`,
      ),
    ).toEqual([
      ".githooks/post-merge:1: a tracked git hook runs the main checkout's binary, because a tree's binary can carry a journal ahead of the operator store; assign main_checkout from --git-common-dir",
    ])
  })
})
