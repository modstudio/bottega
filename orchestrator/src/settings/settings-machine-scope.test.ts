import { expect, test } from 'bun:test'
import {
  decideClaudeMcpPlacementCalls,
  decideMachineSettingsScope,
  desiredClaudeMcpPlacement,
} from './settings-machine-scope.ts'

const facts = [
  { path: '/projects/ready', exists: true, gitMainCheckout: true },
  { path: '/projects/missing', exists: false, gitMainCheckout: false },
  { path: '/projects/folder', exists: true, gitMainCheckout: false },
]

test('global use chooses user scope and cleans registered project scope', () => {
  expect(decideMachineSettingsScope('on', facts)).toEqual({
    user: { mcp: true },
    projects: [
      { path: '/projects/ready', action: 'remove-registration' },
      { path: '/projects/missing', action: 'skip', reason: 'missing path' },
      { path: '/projects/folder', action: 'skip', reason: 'not a git main checkout' },
    ],
  })
})

test('global use off moves MCP registration to usable projects', () => {
  expect(decideMachineSettingsScope('off', facts)).toEqual({
    user: { mcp: false },
    projects: [
      { path: '/projects/ready', action: 'register' },
      { path: '/projects/missing', action: 'skip', reason: 'missing path' },
      { path: '/projects/folder', action: 'skip', reason: 'not a git main checkout' },
    ],
  })
})

test('unchanged Claude MCP placement makes no calls', () => {
  const placement = { scope: 'local' as const, projectPaths: ['/projects/ready'] }
  expect(decideClaudeMcpPlacementCalls(placement, placement).calls).toEqual([])
})

test('a global-use flip removes user scope and adds each project scope', () => {
  const desired = desiredClaudeMcpPlacement(decideMachineSettingsScope('off', facts))
  expect(decideClaudeMcpPlacementCalls({ scope: 'user', projectPaths: [] }, desired).calls).toEqual(
    [
      { action: 'remove', scope: 'user' },
      { action: 'add', scope: 'local', projectPath: '/projects/ready' },
    ],
  )
})

test('a newly registered project needs one local add', () => {
  expect(
    decideClaudeMcpPlacementCalls(
      { scope: 'local', projectPaths: ['/projects/one'] },
      { scope: 'local', projectPaths: ['/projects/one', '/projects/two'] },
    ).calls,
  ).toEqual([{ action: 'add', scope: 'local', projectPath: '/projects/two' }])
})

test('first local placement inspects user scope once before adding projects', () => {
  expect(
    decideClaudeMcpPlacementCalls(null, {
      scope: 'local',
      projectPaths: ['/projects/one', '/projects/two'],
    }).calls,
  ).toEqual([
    { action: 'inspect-and-remove-user', scope: 'user' },
    { action: 'add', scope: 'local', projectPath: '/projects/one' },
    { action: 'add', scope: 'local', projectPath: '/projects/two' },
  ])
})
