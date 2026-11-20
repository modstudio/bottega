import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { listedProjectJson, projectProblems } from './project-list-json.ts'
import type { Project } from './projects.ts'

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
    `probe has no landing branch\ncleared by: ${PLATFORM_SLUG} project set probe --settings '{"trunk":"<branch>"}'`,
  )
})

test('project problems leaves the built-in non-repository tasks row unflagged', () => {
  expect(projectProblems(project('tasks', '/not/a/repository')).join('\n')).not.toContain(
    'landing branch',
  )
})

test('the local project list contract does not expose the hosted write revision', () => {
  expect(
    listedProjectJson({ ...project('tasks', '/not/a/repository'), recordRevision: 7 }),
  ).not.toHaveProperty('recordRevision')
})
