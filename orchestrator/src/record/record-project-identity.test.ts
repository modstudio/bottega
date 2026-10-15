import { expect, test } from 'bun:test'
import {
  recordProjectIdentityDecision,
  type RecordProjectFacts,
} from './record-project-identity.ts'

const project: RecordProjectFacts = {
  id: '01990000-0000-7000-8000-000000001214',
  name: 'current-name',
  spaceId: '01990000-0000-7000-8000-000000000001',
  retired: false,
}

test('project identity prefers id and reports one stale-name mismatch', () => {
  expect(
    recordProjectIdentityDecision({
      requestedId: project.id,
      requestedName: 'stale-name',
      requestedSpaceId: project.spaceId,
      projects: [project],
    }),
  ).toEqual({ status: 'found', project, warnings: ['name-mismatch'] })
})

test('project identity refuses a project from another space', () => {
  expect(
    recordProjectIdentityDecision({
      requestedId: project.id,
      requestedName: project.name,
      requestedSpaceId: '01990000-0000-7000-8000-000000000002',
      projects: [project],
    }),
  ).toEqual({ status: 'outside-space', warnings: [] })
})

test('project identity falls back to the name result without an id', () => {
  expect(
    recordProjectIdentityDecision({
      requestedName: project.name,
      requestedSpaceId: project.spaceId,
      projects: [project],
    }),
  ).toEqual({ status: 'found', project, warnings: [] })
})

test('project identity passes retired facts through for the route to interpret', () => {
  const retired = { ...project, retired: true }
  expect(
    recordProjectIdentityDecision({
      requestedId: retired.id,
      requestedName: retired.name,
      requestedSpaceId: retired.spaceId,
      projects: [retired],
    }),
  ).toEqual({ status: 'found', project: retired, warnings: [] })
})
