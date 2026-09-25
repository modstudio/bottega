import { describe, expect, test } from 'bun:test'
import { planCanonImport } from './canon-import-policy.ts'

describe('planCanonImport', () => {
  test('bootstrap eligibility follows immutable history rather than live rows', () => {
    const desired = [{ slug: 'AGENTS.md', body: 'It used to differ.' }]
    const first = planCanonImport({
      address: { kind: 'project' },
      current: [],
      desired,
      hasHistory: false,
    })
    const afterDeletingEveryRow = planCanonImport({
      address: { kind: 'project' },
      current: [],
      desired,
      hasHistory: true,
    })

    expect(first.bootstrap).toBe(true)
    expect(first.refusal).toBeNull()
    expect(afterDeletingEveryRow.bootstrap).toBe(false)
    expect(afterDeletingEveryRow.refusal).toBe('findings')
  })

  test('refuses an empty desired set while preserving its complete deletion plan', () => {
    const input = {
      address: { kind: 'project' } as const,
      current: [{ slug: '.agents/rules/local.md', body: 'Current rule.' }],
      desired: [],
      hasHistory: true,
      surroundings: [{ global: [{ slug: 'AGENTS.md', body: 'Shared rule.' }], project: [] }],
    }

    const dryRun = planCanonImport(input)
    const hosted = planCanonImport(input)
    expect(dryRun.refusal).toBe('empty')
    expect(dryRun.deletionSlugs).toEqual(hosted.deletionSlugs)
    expect(dryRun.deletionSlugs).toEqual(['.agents/rules/local.md'])
  })

  test('uses the same address policy for project and owner deletions', () => {
    const current = [
      { slug: 'AGENTS.md', body: 'Entry.' },
      { slug: '.agents/rules/old.md', body: 'Old.' },
      { slug: 'legacy.md', body: 'Unmapped.' },
    ]
    const desired = [{ slug: 'AGENTS.md', body: 'Entry.' }]

    expect(
      planCanonImport({
        address: { kind: 'project' },
        current,
        desired,
        hasHistory: true,
      }).deletionSlugs,
    ).toEqual(['.agents/rules/old.md', 'legacy.md'])
    expect(
      planCanonImport({ address: { kind: 'user' }, current, desired, hasHistory: true })
        .deletionSlugs,
    ).toEqual(['.agents/rules/old.md'])
  })
})
