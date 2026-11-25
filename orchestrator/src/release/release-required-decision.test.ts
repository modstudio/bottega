import { describe, expect, test } from 'bun:test'
import { decideRequiredRungs } from './release-required.ts'

describe('decideRequiredRungs', () => {
  test('requires the hosted API for a record migration', () => {
    expect(
      decideRequiredRungs(
        [
          {
            name: 'hosted-api',
            branch: 'main',
            requiredWhenChanged: ['shared/record/migrations/**'],
          },
        ],
        ['shared/record/migrations/20261031_add_column.sql'],
        new Map(),
      ),
    ).toEqual(['hosted-api'])
  })

  test('requires no rung when no path matches', () => {
    expect(
      decideRequiredRungs(
        [
          {
            name: 'hosted-api',
            branch: 'main',
            requiredWhenChanged: ['shared/record/migrations/**'],
          },
        ],
        ['orchestrator/src/run.ts'],
        new Map(),
      ),
    ).toEqual([])
  })

  test('on-demand rungs remain required by a matching change', () => {
    expect(
      decideRequiredRungs(
        [
          {
            name: 'hosted-api',
            branch: 'main',
            onDemand: true,
            requiredWhenChanged: ['shared/record/**'],
          },
        ],
        ['shared/record/schema.ts'],
        new Map(),
      ),
    ).toEqual(['hosted-api'])
  })

  test('several required rungs retain declaration order', () => {
    expect(
      decideRequiredRungs(
        [
          { name: 'second', branch: 'main', requiredWhenChanged: ['shared/**'] },
          { name: 'first', branch: 'main', requiredWhenChanged: ['**/*.ts'] },
          { name: 'unmatched', branch: 'main', requiredWhenChanged: ['docs/**'] },
        ],
        ['shared/record/schema.ts'],
        new Map(),
      ),
    ).toEqual(['second', 'first'])
  })

  test('requires a rung when a changed path is in its entry closure', () => {
    const rungs = [
      {
        name: 'hosted-api',
        branch: 'main',
        entryPoints: ['orchestrator/src/record/server.ts'],
      },
    ]
    const closure = new Map([
      [
        'orchestrator/src/record/server.ts',
        new Set(['orchestrator/src/record/server.ts', 'orchestrator/src/record/evidence.ts']),
      ],
    ])
    expect(decideRequiredRungs(rungs, ['orchestrator/src/record/evidence.ts'], closure)).toEqual([
      'hosted-api',
    ])
    expect(decideRequiredRungs(rungs, ['docs/release.md'], closure)).toEqual([])
  })
})
