import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  sessionResourceReleaseDryRunLines,
  sessionResourceReleaseReport,
  sessionResourceReleaseTargets,
} from './session-close-out-resource-release.ts'

describe('session close-out resource release', () => {
  test('qualifies only wholly terminal chains whose tree release succeeded', () => {
    const runs = [
      { recordId: 'root', rootRecordId: 'root', status: 'ok', worktree: '/removed' },
      { recordId: 'turn', rootRecordId: 'root', status: 'failed', worktree: '/removed' },
      { recordId: 'live', rootRecordId: 'live', status: 'running', worktree: '/live' },
      { recordId: 'held', rootRecordId: 'held', status: 'ok', worktree: '/held' },
    ]

    expect(sessionResourceReleaseTargets(runs, ['root', 'live'])).toEqual([
      {
        rootRecordId: 'root',
        path: '/removed',
        runRecordIds: ['root', 'turn'],
      },
    ])
  })

  test('maps reclamation, holds, and failures onto close-out report lines', () => {
    const target = { rootRecordId: 'root', path: '/removed', runRecordIds: ['root'] }
    expect(
      sessionResourceReleaseReport(
        target,
        {
          reclaimed: ['terminated pid 42'],
          kept: [{ item: 'process 43', reason: 'identity changed', pid: 43 }],
          errors: ['inventory unavailable'],
        },
        {
          reclaimed: ['removed container app'],
          kept: [
            {
              item: 'Compose project data',
              reason: 'shared by a live tree',
              composeProject: 'data',
            },
          ],
          errors: ['Docker unavailable'],
        },
      ),
    ).toEqual({
      mechanical: [
        'reclaimed process: terminated pid 42',
        'reclaimed Compose resource: removed container app',
      ],
      process: [
        {
          item: 'process 43',
          reason: 'identity changed',
          evidence: 'removed tree /removed for run chain root',
          remedy: `${PLATFORM_SLUG} machine reclaim orphan-process 43`,
        },
        {
          item: 'removed-tree processes',
          reason: 'inventory unavailable',
          evidence: 'removed tree /removed for run chain root',
          remedy: `${PLATFORM_SLUG} session close-out`,
        },
        {
          item: 'Compose project data',
          reason: 'shared by a live tree',
          evidence: 'removed tree /removed for run chain root',
          remedy: 'inspect with docker compose -p data ps; remove it by hand only if it is residue',
        },
        {
          item: 'removed-tree Compose resources',
          reason: 'Docker unavailable',
          evidence: 'removed tree /removed for run chain root',
          remedy: `${PLATFORM_SLUG} session close-out`,
        },
      ],
    })
    expect(sessionResourceReleaseDryRunLines([target])).toEqual([
      'would reclaim processes for removed tree /removed',
      'would reclaim Compose resources for removed tree /removed',
    ])
  })
})
