import { describe, expect, test } from 'bun:test'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import {
  decideProjectCheckoutAdoptions,
  type ProjectCheckoutFacts,
} from './project-checkout-adoption-decision.ts'

const hosted = (name: string, retiredAt: string | null = null): RecordProject => ({
  id: `id-${name}`,
  spaceId: 'space-a',
  spaceName: 'Space A',
  name,
  keyPrefixes: [],
  stack: 'typescript',
  managedContext: true,
  landingBranch: 'main',
  color: null,
  colorDark: null,
  retiredAt,
  canon: true,
  settings: { trunk: 'main' },
})

const acceptable: ProjectCheckoutFacts = {
  directoryExists: true,
  topLevel: true,
  linkedWorktree: false,
  bareRepository: false,
  originUrl: true,
}

function decide(
  project: RecordProject,
  facts: ProjectCheckoutFacts,
  localProjects: readonly { name: string; retiredAt: string | null }[] = [],
) {
  return decideProjectCheckoutAdoptions({
    hostedProjects: [project],
    localProjects,
    candidates: new Map([[project.name, { path: `/projects/${project.name}`, facts }]]),
  })
}

test('adopts an acceptable hosted checkout', () => {
  expect(decide(hosted('alpha'), acceptable)).toEqual([
    { kind: 'adopt', project: hosted('alpha'), path: '/projects/alpha' },
  ])
})

test.each([
  ['live', null],
  ['retired', '2026-11-19T00:00:00.000Z'],
] as const)('an already registered %s project is silent', (_state, retiredAt) => {
  expect(decide(hosted('alpha'), acceptable, [{ name: 'alpha', retiredAt }])).toEqual([])
})

test('reports a missing candidate directory', () => {
  expect(decide(hosted('alpha'), { ...acceptable, directoryExists: false })).toEqual([
    { kind: 'missing', project: hosted('alpha'), path: '/projects/alpha' },
  ])
})

describe.each([
  ['not a git work tree', { topLevel: false }, 'not the top of a git work tree'],
  ['a linked worktree', { linkedWorktree: true }, 'linked worktrees cannot be registered'],
  ['a bare repository', { bareRepository: true }, 'bare repositories cannot be registered'],
  ['without an origin', { originUrl: false }, 'remote.origin.url is unset'],
] as const)('%s', (_label, changed, message) => {
  test('is refused with a remedy', () => {
    const [outcome] = decide(hosted('alpha'), { ...acceptable, ...changed })
    expect(outcome?.kind).toBe('refuse')
    if (outcome?.kind !== 'refuse') throw new Error('expected refusal')
    expect(outcome.message).toContain(message)
    expect(outcome.message).toContain('then sign in again')
  })
})

test('skips a retired hosted row', () => {
  expect(decide(hosted('alpha', '2026-11-19T00:00:00.000Z'), acceptable)).toEqual([])
})
