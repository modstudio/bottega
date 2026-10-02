import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fillAbsentProjectSettings } from './project-commands.ts'
import { projectByName, upsertProject } from './projects.ts'

test('fills recipePath while preserving existing worktree settings', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orch-setup-worktree-fill-'))
  const recipePath = `.${PLATFORM_SLUG}/worktree-recipe.jsonc`
  mkdirSync(join(path, `.${PLATFORM_SLUG}`))
  writeFileSync(join(path, recipePath), '{"worktree":{"create":[]}}\n')
  const readonlyProvision = [{ path: 'node_modules', method: 'link' as const }]
  upsertProject({
    name: 'setup-worktree-fill',
    path,
    settings: {
      worktree: { branch: 'orch/{id}', readonly_provision: readonlyProvision },
    },
  })
  await fillAbsentProjectSettings({
    name: 'setup-worktree-fill',
    fill: { settings: { worktree: { recipePath } } },
  })
  expect(projectByName('setup-worktree-fill')?.settings.worktree).toEqual({
    branch: 'orch/{id}',
    readonly_provision: readonlyProvision,
    recipePath,
  })
})
