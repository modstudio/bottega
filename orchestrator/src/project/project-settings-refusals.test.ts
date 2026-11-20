import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ProjectSettings } from './project-settings.ts'
import { validateProjectSettings, validateRegisterWrite } from './projects.ts'

function settings(run: string): ProjectSettings {
  return {
    release: {
      rungs: [],
      mergeMethod: 'squash',
      requiredChecks: [],
      beforePullRequest: [{ whenChanged: ['shared/record/migrations/**'], run }],
    },
  }
}

test('register writes normalize every tree-script command form and scope the platform list', () => {
  const cases: Array<{
    name: string
    project: string
    settings: ProjectSettings
    problem?: string
  }> = [
    ...[
      'bun scripts/x.ts',
      'bun ./scripts/x.ts',
      'bun run ./scripts/x.ts',
      'node ./scripts/x.ts --flag',
      'bun "scripts/x.ts"',
      'sh -c "bun scripts/x.ts"',
      'bun hub/scripts/x.ts',
      'bun ./hub/scripts/x.ts',
    ].map((run) => ({
      name: run,
      project: PLATFORM_SLUG,
      settings: settings(run),
      problem: `release.beforePullRequest.0.run executes unlisted tree script ${run.includes('hub/') ? 'hub/scripts/x.ts' : 'scripts/x.ts'}; add it to shared/tree-run-scripts.ts`,
    })),
    {
      name: 'listed rehearsal',
      project: PLATFORM_SLUG,
      settings: settings('bun scripts/record-rehearse.ts'),
    },
    {
      name: 'listed nested script',
      project: PLATFORM_SLUG,
      settings: settings('bun hub/scripts/test-postgres-evidence.ts'),
    },
    {
      name: 'other project',
      project: 'another-project',
      settings: settings('bun scripts/arbitrary.ts'),
    },
    {
      name: 'inline recipe',
      project: PLATFORM_SLUG,
      settings: { worktree: { recipe: { install: 'bun ./scripts/x.ts' } } },
      problem:
        'worktree.recipe.install executes unlisted tree script scripts/x.ts; add it to shared/tree-run-scripts.ts',
    },
  ]

  for (const row of cases) {
    expect(
      validateRegisterWrite({
        merged: row.settings,
        context: { currentProjectName: row.project },
      }),
      row.name,
    ).toEqual(row.problem ? [row.problem] : [])
  }
})

test('tree-script guard applies only to strict register writes', () => {
  const unlisted = settings('bun scripts/newer.ts')
  expect(
    validateProjectSettings(unlisted, 'strip', undefined, {
      currentProjectName: PLATFORM_SLUG,
    }),
  ).toEqual([])
  expect(
    validateProjectSettings(unlisted, 'strict', undefined, {
      currentProjectName: PLATFORM_SLUG,
    }),
  ).toEqual([
    'release.beforePullRequest.0.run executes unlisted tree script scripts/newer.ts; add it to shared/tree-run-scripts.ts',
  ])
})
