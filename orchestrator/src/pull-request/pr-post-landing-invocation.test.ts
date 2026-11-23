import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { projectMovesInstallation } from '../database/machine-update-mover.ts'
import type { Project } from '../project/projects.ts'
import { postLandingHandOffInvocation } from './pr-post-landing.ts'

const project = {
  name: 'fixture',
  path: '/fixture/project',
  settings: { trunk: 'main' },
} as Project

test('another project uses the plain move and the current installation hand-off', () => {
  const movesInstallation = projectMovesInstallation(project)

  expect(movesInstallation).toBeFalse()
  expect(postLandingHandOffInvocation(project.path, movesInstallation)).toEqual({
    argv: bottegaEntryArgv(PLATFORM_SLUG),
  })
})

test('the post-landing child for a moved platform checkout runs through its binary', () => {
  expect(postLandingHandOffInvocation(project.path, true)).toEqual({
    argv: [`${project.path}/bin/${PLATFORM_SLUG}`],
    cwd: project.path,
  })
})
