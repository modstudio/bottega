import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type AddHostedProject, decideProjectAdd } from './project-add-decision.ts'

const memberships = [
  { spaceId: 'space-a', slug: 'alpha', permission: 'write' },
  { spaceId: 'space-b', slug: 'beta', permission: 'write' },
]

function hosted(overrides: Partial<AddHostedProject> = {}): AddHostedProject {
  return {
    id: 'project-a',
    name: 'probe',
    spaceId: 'space-a',
    spaceName: 'Alpha',
    keyPrefixes: ['DEV'],
    stack: 'typescript',
    managedContext: true,
    landingBranch: 'main',
    color: null,
    colorDark: null,
    retiredAt: null,
    canon: true,
    settings: { trunk: 'main', keyPrefixes: ['DEV'] },
    ...overrides,
  }
}

describe('decideProjectAdd', () => {
  test('adopts the hosted identity, stack, and settings while retaining local-only settings', () => {
    expect(
      decideProjectAdd({
        name: 'probe',
        requestedStack: 'sniffed-stack',
        stackWasRequested: false,
        requestedSettings: { checks: { spelling: true } },
        hostedProjects: [hosted()],
        memberships,
        activeSpaceId: 'space-b',
      }),
    ).toEqual({
      decision: {
        kind: 'adopt',
        recordId: 'project-a',
        stack: 'typescript',
        settings: {
          trunk: 'main',
          keyPrefixes: ['DEV'],
          checks: { spelling: true },
          space: 'alpha',
        },
        space: 'alpha',
      },
      targetSpace: { id: 'space-a', label: 'alpha' },
    })
  })

  test('refuses requested hosted settings that differ and names every key', () => {
    const decision = decideProjectAdd({
      name: 'probe',
      requestedStack: 'php',
      stackWasRequested: true,
      requestedSettings: { trunk: 'develop', keyPrefixes: ['OTHER'] },
      hostedProjects: [hosted()],
      memberships,
      activeSpaceId: 'space-a',
    })
    expect(decision.decision.kind).toBe('refuse')
    if (decision.decision.kind !== 'refuse') return
    expect(decision.decision.reason).toContain('stack, trunk, keyPrefixes')
    expect(decision.decision.reason).toContain(`${PLATFORM_SLUG} project set probe`)
  })

  test('refuses adoption from a server response that predates adoption fields', () => {
    const previousShape = hosted()
    delete previousShape.settings
    delete previousShape.canon

    expect(
      decideProjectAdd({
        name: 'probe',
        requestedStack: null,
        stackWasRequested: false,
        requestedSettings: {},
        hostedProjects: [previousShape],
        memberships,
        activeSpaceId: 'space-a',
      }),
    ).toEqual({
      decision: {
        kind: 'refuse',
        reason:
          'the hosted record server predates project adoption; release the record API, then retry',
      },
    })
  })

  test('refuses an ambiguous name and lists its spaces', () => {
    expect(
      decideProjectAdd({
        name: 'probe',
        requestedStack: null,
        stackWasRequested: false,
        requestedSettings: {},
        hostedProjects: [hosted(), hosted({ id: 'project-b', spaceId: 'space-b' })],
        memberships,
        activeSpaceId: 'space-a',
      }),
    ).toEqual({
      decision: {
        kind: 'refuse',
        reason:
          'hosted project "probe" exists in multiple record spaces: alpha, beta; choose one with --space <id-or-slug>',
      },
    })
  })

  test('selects one matching membership by space slug', () => {
    expect(
      decideProjectAdd({
        name: 'probe',
        requestedStack: null,
        stackWasRequested: false,
        requestedSettings: {},
        selectedSpace: 'beta',
        hostedProjects: [hosted(), hosted({ id: 'project-b', spaceId: 'space-b' })],
        memberships,
        activeSpaceId: 'space-a',
      }),
    ).toMatchObject({
      decision: { kind: 'adopt', recordId: 'project-b', space: 'beta' },
      targetSpace: { id: 'space-b', label: 'beta' },
    })
  })

  test('mints unchanged when the name is absent and carries an explicit destination', () => {
    expect(
      decideProjectAdd({
        name: 'new-project',
        requestedStack: 'typescript',
        stackWasRequested: true,
        requestedSettings: { checks: { spelling: true } },
        selectedSpace: 'space-b',
        hostedProjects: [hosted()],
        memberships,
        activeSpaceId: 'space-a',
      }),
    ).toEqual({
      decision: {
        kind: 'mint',
        settings: { checks: { spelling: true }, space: 'beta' },
      },
      targetSpace: { id: 'space-b', label: 'beta' },
    })
  })

  test('resolves a case-insensitive space id to its membership instead of the active space', () => {
    expect(
      decideProjectAdd({
        name: 'new-project',
        requestedStack: 'typescript',
        stackWasRequested: true,
        requestedSettings: {},
        selectedSpace: 'SPACE-B',
        hostedProjects: [hosted()],
        memberships,
        activeSpaceId: 'space-a',
      }),
    ).toEqual({
      decision: { kind: 'mint', settings: { space: 'beta' } },
      targetSpace: { id: 'space-b', label: 'beta' },
    })
  })
})
