import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from './projects.ts'
import { projectProblems } from './project-list-json.ts'

function project(name: string, path: string): Project {
  return {
    recordId: `record-${name}`,
    name,
    path,
    stack: null,
    canon: true,
    retiredAt: null,
    settings: {},
  }
}

test('project problems flags a git-backed row without a landing branch', () => {
  expect(projectProblems(project('probe', process.cwd()))).toContain(
    `probe has no landing branch; cleared by: ${PLATFORM_SLUG} project set probe --settings '{"trunk":"<branch>"}'`,
  )
})

test('project problems leaves the built-in non-repository tasks row unflagged', () => {
  expect(projectProblems(project('tasks', '/not/a/repository')).join('\n')).not.toContain(
    'landing branch',
  )
})
