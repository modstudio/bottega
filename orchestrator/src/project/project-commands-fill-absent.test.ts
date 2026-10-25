import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fillAbsentProjectSettings } from './project-commands.ts'
import type { ProjectSettings } from './project-settings.ts'
import { projectByName, upsertProject } from './projects.ts'

/** A risk path a newer binary wrote: `weight` is a key this one has never heard of. */
const weightedRiskPath = {
  pattern: '^hub/web/',
  tier: 3,
  reason: 'dashboard',
  firm: true,
  weight: 2,
}

const settingsCarrying = (path: unknown) =>
  ({
    review: { lenses: [], risk: { paths: [path], unlisted: 0 } },
  }) as unknown as ProjectSettings

afterEach(() => mock.restore())

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('fills recipePath while preserving existing worktree settings', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orch-setup-worktree-fill-'))
  const recipePath = `.${PLATFORM_SLUG}/worktree-recipe.jsonc`
  mkdirSync(join(path, `.${PLATFORM_SLUG}`))
  writeFileSync(join(path, recipePath), '{"worktree":{"create":[]}}\n')
  const readonlyProvision = [{ path: 'node_modules', method: 'link' as const }]
  upsertProject({
    recordId: newRecordId(),
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

test('fill-absent judges a supplied key strictly and a stored one leniently', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orch-fill-stored-unknown-'))
  upsertProject({
    recordId: newRecordId(),
    name: 'setup-fill-stored-unknown',
    path,
    settings: settingsCarrying(weightedRiskPath),
  })
  await fillAbsentProjectSettings({
    name: 'setup-fill-stored-unknown',
    fill: { settings: { search: { code: true } } },
  })
  expect(projectByName('setup-fill-stored-unknown')?.settings).toMatchObject({
    search: { code: true },
    review: { risk: { paths: [weightedRiskPath] } },
  })

  upsertProject({
    recordId: newRecordId(),
    name: 'setup-fill-supplied-unknown',
    path: '/projects/setup-fill-supplied-unknown',
    settings: {},
  })
  await expect(
    fillAbsentProjectSettings({
      name: 'setup-fill-supplied-unknown',
      fill: { settings: settingsCarrying(weightedRiskPath) },
    }),
  ).rejects.toThrow('review.risk.paths.0: Unrecognized key: "weight"')
  expect(projectByName('setup-fill-supplied-unknown')?.settings).toEqual({})
})

test('recomputes the branch check when the candidate changes before the write', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'setup-fill-race',
    path: '/projects/old',
    settings: {},
  })
  let checks = 0
  spyOn(Bun, 'spawnSync').mockImplementation((() => {
    checks += 1
    if (checks === 1) {
      upsertProject({
        recordId: newRecordId(),
        name: 'setup-fill-race',
        path: '/projects/new',
        settings: {},
      })
    }
    return spawnResult('main\n')
  }) as typeof Bun.spawnSync)

  await fillAbsentProjectSettings({
    name: 'setup-fill-race',
    fill: { settings: { trunk: 'main' } },
  })

  expect(checks).toBe(2)
  expect(projectByName('setup-fill-race')).toMatchObject({
    path: '/projects/new',
    settings: { trunk: 'main' },
  })
})
