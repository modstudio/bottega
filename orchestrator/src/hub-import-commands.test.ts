import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { registeredHubCheckout } from './hub-import-commands.ts'

describe('hub import judge applicability', () => {
  const project = { name: PLATFORM_SLUG, path: '/registered/workshop' }

  test('does not judge a matching path outside the registered checkout', () => {
    expect(registeredHubCheckout('/scratch/other/hub/ui/example.ts', project)).toBeNull()
  })

  test('judges hub paths in the main checkout and its managed worktrees', () => {
    expect(registeredHubCheckout('/registered/workshop/hub/ui/example.ts', project)).toBe(
      '/registered/workshop',
    )
    expect(
      registeredHubCheckout(
        '/registered/workshop/.claude/worktrees/orch-1/hub/web/src/main.tsx',
        project,
      ),
    ).toBe('/registered/workshop/.claude/worktrees/orch-1')
  })
})
