import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import {
  hostedProjectAddInput,
  missingCheckoutMessage,
  registerCheckedOutHostedProjects,
} from './project-checkout-adoption.ts'

const hostedProject: RecordProject = {
  id: 'project-alpha',
  spaceId: 'space-a',
  spaceName: 'Space A',
  name: 'alpha',
  keyPrefixes: [],
  stack: 'hosted-stack',
  managedContext: true,
  landingBranch: 'main',
  color: null,
  colorDark: null,
  retiredAt: null,
  canon: false,
  settings: { trunk: 'main' },
}

test('registers with the hosted canon and stack', () => {
  expect(hostedProjectAddInput(hostedProject, '/projects/alpha')).toMatchObject({
    name: 'alpha',
    path: '/projects/alpha',
    canon: false,
    stack: 'hosted-stack',
    settings: { trunk: 'main' },
    selectedSpace: 'space-a',
  })
})

test('the missing-checkout remedy names a portable placeholder, not the missing directory', () => {
  const message = missingCheckoutMessage({
    name: 'alpha',
    space: 'team-space',
    path: '/projects/alpha',
  })
  expect(message).toContain(`${PLATFORM_SLUG} project add <path> --name alpha`)
  expect(message).not.toContain(`${PLATFORM_SLUG} project add /projects/alpha`)
})

test('sign-in explains that machine initialization registers checkouts when no space is pinned', async () => {
  await expect(
    registerCheckedOutHostedProjects({
      readPinnedIdentity: () => null,
      readCloneRoot: () => '/projects',
    }),
  ).resolves.toEqual([
    {
      status: 'missing',
      message: `projects checked out under /projects are registered once this machine is initialized: ${PLATFORM_SLUG} machine config machine init --space <slug>`,
    },
  ])
})
