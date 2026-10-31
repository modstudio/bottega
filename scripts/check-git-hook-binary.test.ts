import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { gitHookBinaryViolations } from './check-git-hook-binary.ts'

const assignment = `common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}`
const rule =
  "a hook that runs the binary names the main checkout's copy, because a tree's binary can carry a journal ahead of the operator store"

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

  test('accepts a heartbeat-style hook that resolves git from its root', () => {
    expect(
      gitHookBinaryViolations(
        'orchestrator/hooks/orch-heartbeat.sh',
        `common_dir=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)
main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}
${PLATFORM_SLUG.toUpperCase()}="$main_checkout/bin/${PLATFORM_SLUG}"`,
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
    ).toEqual([`.githooks/pre-push:4: ${rule}`])
  })

  test('requires a common directory assignment when the hook names the binary', () => {
    expect(
      gitHookBinaryViolations(
        '.githooks/post-merge',
        `main_checkout=\${BOTTEGA_MAIN_CHECKOUT:-$(dirname "$common_dir")}
"$main_checkout/bin/${PLATFORM_SLUG}" machine migrate`,
      ),
    ).toEqual([`.githooks/post-merge:1: ${rule}; assign main_checkout from --git-common-dir`])
  })
})
