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

test('refuses an unlisted platform tree-run script at the register write edge', () => {
  expect(
    validateRegisterWrite({
      merged: settings('bun scripts/unlisted.ts'),
      context: { currentProjectName: PLATFORM_SLUG },
    }),
  ).toEqual([
    'release.beforePullRequest.0.run executes unlisted tree script scripts/unlisted.ts; add it to shared/tree-run-scripts.ts',
  ])
})

test('accepts the declared record rehearsal tree-run script', () => {
  expect(
    validateRegisterWrite({
      merged: settings('bun scripts/record-rehearse.ts'),
      context: { currentProjectName: PLATFORM_SLUG },
    }),
  ).toEqual([])
})

test('does not apply platform tree-run declarations to another project', () => {
  expect(
    validateRegisterWrite({
      merged: settings('bun scripts/arbitrary.ts'),
      context: { currentProjectName: 'another-project' },
    }),
  ).toEqual([])
})
