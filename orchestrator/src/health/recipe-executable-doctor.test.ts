import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recipeExecutableDoctorLines } from './recipe-executable-doctor.ts'

test('reports missing tools from every tracked recipe phase', () => {
  expect(
    recipeExecutableDoctorLines(
      PLATFORM_SLUG,
      {
        create: [{ name: 'root-deps', run: { command: 'bun', args: [] } }],
        refresh: [{ name: 'refresh-root-deps', run: { command: 'bun', args: [] } }],
      },
      () => false,
    ),
  ).toEqual([
    `recipe tool    MISSING — project ${PLATFORM_SLUG} worktree recipe step root-deps (create) needs bun, which is not on PATH; install bun, then retry`,
    `recipe tool    MISSING — project ${PLATFORM_SLUG} worktree recipe step refresh-root-deps (refresh) needs bun, which is not on PATH; install bun, then retry`,
  ])
})
