import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ProjectSettings } from './project-settings.ts'
import { validateRegisterWrite } from './projects.ts'

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

test('register writes normalize every tree-script command form and scope the list to Bottega', () => {
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
    ].map((run) => ({
      name: run,
      project: PLATFORM_SLUG,
      settings: settings(run),
      problem:
        'release.beforePullRequest.0.run executes unlisted tree script scripts/x.ts; add it to shared/tree-run-scripts.ts',
    })),
    {
      name: 'listed rehearsal',
      project: PLATFORM_SLUG,
      settings: settings('bun scripts/record-rehearse.ts'),
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
