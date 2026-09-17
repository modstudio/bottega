import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROJECT_CONFIG_PATH } from '../worktree-lifecycle.ts'
import type { Project } from './projects.ts'
import { worktreeWarnings } from './projects.ts'

const project = (path: string, worktree: Record<string, unknown>): Project => ({
  id: 1,
  name: 'sample',
  path,
  stack: null,
  canon: true,
  retiredAt: null,
  settings: { worktree },
})

const noLifecycle = (warnings: string[]) =>
  warnings.some((w) => w.includes('cannot make a worktree'))

describe('worktree warnings follow the resolved lifecycle', () => {
  test('a project relying on the default config file is not reported as unable to make a worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-warn-'))
    writeFileSync(join(root, DEFAULT_PROJECT_CONFIG_PATH), '{"worktree":{"create":[]}}\n')
    expect(noLifecycle(worktreeWarnings(project(root, { branch: '{key}-orch-{id}' })))).toBeFalse()
  })

  test('a project with neither a declaration nor the default file still says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-warn-'))
    expect(noLifecycle(worktreeWarnings(project(root, { branch: '{key}-orch-{id}' })))).toBeTrue()
  })
})
