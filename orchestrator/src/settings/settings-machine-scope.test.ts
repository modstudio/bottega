import { expect, test } from 'bun:test'
import { decideMachineSettingsScope, scopedProjectHasDrift } from './settings-machine-scope.ts'

const facts = [
  { path: '/projects/ready', exists: true, gitMainCheckout: true },
  { path: '/projects/missing', exists: false, gitMainCheckout: false },
  { path: '/projects/folder', exists: true, gitMainCheckout: false },
]

test('global use chooses user scope and cleans registered project scope', () => {
  expect(decideMachineSettingsScope('on', facts)).toEqual({
    user: { rendered: 'all', mcp: true },
    projects: [
      { path: '/projects/ready', action: 'remove-rendered-and-registration' },
      { path: '/projects/missing', action: 'skip', reason: 'missing path' },
      { path: '/projects/folder', action: 'skip', reason: 'not a git main checkout' },
    ],
  })
})

test('global use off keeps hooks global and moves settings and MCP to usable projects', () => {
  expect(decideMachineSettingsScope('off', facts)).toEqual({
    user: { rendered: 'hooks', mcp: false },
    projects: [
      { path: '/projects/ready', action: 'render-and-register' },
      { path: '/projects/missing', action: 'skip', reason: 'missing path' },
      { path: '/projects/folder', action: 'skip', reason: 'not a git main checkout' },
    ],
  })
})

test('drift is classified at the selected user and project scopes', () => {
  expect(scopedProjectHasDrift(true, true)).toBe(false)
  expect(scopedProjectHasDrift(false, true)).toBe(true)
  expect(scopedProjectHasDrift(true, false)).toBe(true)
})
