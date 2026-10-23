import { describe, expect, test } from 'bun:test'
import { workflowsAfterReplacement } from './workflow-definition.ts'
import {
  preflightSharedWorkflowTargets,
  sharedWorkflowPromotionSpaces,
  type WorkflowPromotionVersion,
} from './workflow-shared-promotion.ts'

const shared = (
  spaceId: string | null,
  n: number,
  status: WorkflowPromotionVersion['status'] = 'production',
  definition = `definition-${n}`,
): WorkflowPromotionVersion => ({ spaceId, n, status, author: 'seed', definition })

describe('shared workflow promotion spaces', () => {
  test('a space with an identical prefix follows the source to its target', () => {
    const versions = [
      ...[15, 16, 17, 18, 19].map((n) => shared('source', n, 'retired')),
      shared('source', 20, 'draft'),
      ...[15, 16].map((n) => shared('follower', n, 'retired')),
      shared('follower', 17),
    ]

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source', 'follower'],
      overrides: [],
      pinned: [],
    })
  })

  test('a space with a differing version is an override', () => {
    const versions = [shared('source', 17), shared('source', 20, 'draft'), shared('own', 17)]
    versions[2]!.definition = 'different'

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source'],
      overrides: ['own'],
      pinned: [],
    })
  })

  test('a space with a version absent from the source is an override', () => {
    const versions = [shared('source', 20, 'draft'), shared('own', 17)]

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source'],
      overrides: ['own'],
      pinned: [],
    })
  })

  test('a session-promoted latest production follows the source', () => {
    const versions = [
      ...[15, 16, 17, 18, 19].map((n) => shared('source', n, 'retired')),
      shared('source', 20, 'draft'),
      ...[15, 16].map((n) => shared('follower', n, 'retired')),
      { ...shared('follower', 17), author: 'session' },
    ]
    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source', 'follower'],
      overrides: [],
      pinned: [],
    })
  })

  test('an interrupted copy with matching drafts follows on retry', () => {
    const versions = [
      shared('source', 17, 'retired'),
      shared('source', 18, 'retired'),
      shared('source', 19, 'retired'),
      shared('source', 20, 'draft'),
      shared('follower', 17),
      shared('follower', 18, 'draft'),
      shared('follower', 19, 'draft'),
    ]
    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source', 'follower'],
      overrides: [],
      pinned: [],
    })
  })

  test('keeps a space with a retired version above production', () => {
    const versions = [
      shared('source', 17, 'retired'),
      shared('source', 18, 'retired'),
      shared('source', 20, 'draft'),
      shared('pinned', 17),
      shared('pinned', 18, 'retired'),
    ]
    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source')).toEqual({
      changed: ['source'],
      overrides: [],
      pinned: ['pinned'],
    })
  })
})

describe('shared workflow catalogue preflight inputs', () => {
  test('replaces the outgoing production workflow with the incoming definition', () => {
    const rows = [
      { slug: 'shared', definition: JSON.stringify({ steps: ['drop-x'] }) },
      { slug: 'other', definition: JSON.stringify({ steps: ['keep-y'] }) },
    ]
    const incoming = { steps: ['keep-y'] }

    expect(workflowsAfterReplacement(rows, 'shared', incoming)).toEqual([
      { slug: 'shared', definition: JSON.stringify(incoming) },
      rows[1]!,
    ])
  })

  test('adds an incoming workflow when the target space has no production version', () => {
    const incoming = { steps: ['keep-y'] }
    expect(workflowsAfterReplacement([], 'shared', incoming)).toEqual([
      { slug: 'shared', definition: JSON.stringify(incoming) },
    ])
  })

  test('uses the source catalogue for a follower and its production catalogue for an override', () => {
    const sourceCatalogue = shared('source', 2, 'production', JSON.stringify({ plan: 'source' }))
    const versions = [
      shared('source', 1, 'retired', JSON.stringify({ plan: 'common' })),
      sourceCatalogue,
      shared('follower', 1, 'production', JSON.stringify({ plan: 'common' })),
      shared('override', 1, 'production', JSON.stringify({ plan: 'override' })),
    ]
    const planned: [string | null, unknown][] = []

    expect(
      preflightSharedWorkflowTargets({
        slug: 'shared',
        definition: { title: 'incoming' },
        sourceSpace: 'source',
        spaces: ['follower', 'override'],
        catalogueVersions: versions,
        sourceCatalogue,
        missingCatalogueRefusal: 'missing catalogue',
        preflight: (_definition, spaceId, catalogue) => {
          planned.push([spaceId, catalogue])
          if (spaceId === 'override') throw new Error('does not carry workflow')
        },
      }),
    ).toEqual([
      {
        spaceId: 'override',
        disposition: 'override',
        plannedVersion: 1,
        reason: 'does not carry workflow',
      },
    ])
    expect(planned).toEqual([
      ['follower', { plan: 'source' }],
      ['override', { plan: 'override' }],
    ])
  })

  test('refuses when a follower catalogue cannot carry the workflow', () => {
    const sourceCatalogue = shared('source', 2, 'production', JSON.stringify({ plan: 'source' }))

    expect(() =>
      preflightSharedWorkflowTargets({
        slug: 'shared',
        definition: { title: 'incoming' },
        sourceSpace: 'source',
        spaces: ['follower'],
        catalogueVersions: [
          shared('source', 1, 'retired', JSON.stringify({ plan: 'common' })),
          sourceCatalogue,
          shared('follower', 1, 'production', JSON.stringify({ plan: 'common' })),
        ],
        sourceCatalogue,
        missingCatalogueRefusal: 'missing catalogue',
        preflight: () => {
          throw new Error('does not carry workflow')
        },
      }),
    ).toThrow(
      'refusing shared workflow promotion for "shared": space follower catalogue follower planned version 2 cannot carry the workflow: does not carry workflow',
    )
  })
})
