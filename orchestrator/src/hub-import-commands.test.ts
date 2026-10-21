import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { registeredHubCheckout } from './hub-import-commands.ts'

describe('hub import judge applicability', () => {
  test('does not judge a matching path outside the registered checkout', () => {
    const project = { name: PLATFORM_SLUG, path: '/registered/workshop' }
    expect(registeredHubCheckout('/scratch/other/hub/ui/example.ts', project)).toBeNull()
  })

  test('rejects symlink escapes and judges a sibling registered worktree', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hub-import-applicability-'))
    const projectPath = join(scratch, 'workshop')
    const worktree = join(projectPath, '.claude/worktrees/orch-sibling')
    const outside = join(scratch, 'outside')
    mkdirSync(join(projectPath, 'hub/web/src/components'), { recursive: true })
    mkdirSync(join(worktree, 'hub/web/src/components'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'leak.ts'), 'export const marker = true\n')
    symlinkSync(join(outside, 'leak.ts'), join(projectPath, 'hub/web/src/components/leak.ts'))
    symlinkSync(outside, join(projectPath, 'hub/web/src/components/linked-parent'))
    const project = { name: PLATFORM_SLUG, path: projectPath }
    try {
      expect(
        registeredHubCheckout(join(projectPath, 'hub/web/src/components/leak.ts'), project),
      ).toBeNull()
      expect(
        registeredHubCheckout(
          join(projectPath, 'hub/web/src/components/linked-parent/probe.ts'),
          project,
        ),
      ).toBeNull()
      expect(
        registeredHubCheckout(join(worktree, 'hub/web/src/components/probe.ts'), project),
      ).toEqual({
        checkout: realpathSync(worktree),
        file: join(realpathSync(worktree), 'hub/web/src/components/probe.ts'),
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
