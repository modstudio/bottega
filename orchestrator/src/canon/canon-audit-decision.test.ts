import { describe, expect, test } from 'bun:test'
import { decideCanonAuditNotes, decideCanonAuditRun } from './canon-audit-decision.ts'

const note = (
  text: string,
  overrides: Partial<{
    id: number
    stale_at: string | null
    stale_reason: string | null
    promoted_task: string | null
    last_seen_at: string
  }> = {},
) => ({
  id: 1,
  text,
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
  last_seen_at: '2026-09-24T12:00:00.000Z',
  ...overrides,
})

const finding = (
  overrides: Partial<{
    file: string
    line: number
    rule: string
    message: string
  }> = {},
) => ({
  file: '.agents/rules/canon.md',
  line: 12,
  rule: 'canon/reference',
  message: 'named path does not resolve',
  project: 'workshop',
  ...overrides,
})

describe('canon audit filing decision', () => {
  test('files a new finding', () => {
    expect(decideCanonAuditNotes([finding()], [])).toEqual([
      {
        text: 'canon audit: workshop canon/reference .agents/rules/canon.md:12 named path does not resolve',
      },
    ])
  })

  test('does not file a finding whose identity matches a live note', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon.md:12 named path does not resolve'
    expect(decideCanonAuditNotes([finding()], [note(existing)])).toEqual([])
  })

  test('keeps one identity when a finding in a spaced path moves', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon cards/worker guide.md:4 named path does not resolve'
    expect(
      decideCanonAuditNotes(
        [finding({ file: '.agents/rules/canon cards/worker guide.md', line: 41 })],
        [note(existing)],
      ),
    ).toEqual([])
  })

  test('keeps one identity when a message containing a colon and digits moves', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon.md:4 reference at example:12 is stale'
    expect(
      decideCanonAuditNotes(
        [finding({ line: 41, message: 'reference at example:12 is stale' })],
        [note(existing)],
      ),
    ).toEqual([])
  })

  test('files findings with different rules or files', () => {
    expect(
      decideCanonAuditNotes(
        [finding(), finding({ file: 'AGENTS.md' }), finding({ rule: 'canon/prose' })],
        [],
      ),
    ).toEqual([
      {
        text: 'canon audit: workshop canon/reference .agents/rules/canon.md:12 named path does not resolve',
      },
      { text: 'canon audit: workshop canon/reference AGENTS.md:12 named path does not resolve' },
      {
        text: 'canon audit: workshop canon/prose .agents/rules/canon.md:12 named path does not resolve',
      },
    ])
  })

  test('does not refile a finding whose note was dropped', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon.md:4 named path does not resolve'
    expect(
      decideCanonAuditNotes(
        [finding()],
        [
          note(existing, {
            stale_at: '2026-09-24T12:00:00.000Z',
            stale_reason: 'dropped: not actionable',
          }),
        ],
      ),
    ).toEqual([])
  })

  test('does not refile a finding whose note was promoted and became stale', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon.md:4 named path does not resolve'
    expect(
      decideCanonAuditNotes(
        [finding()],
        [
          note(existing, {
            stale_at: '2026-09-24T12:00:00.000Z',
            stale_reason: 'anchor content changed',
            promoted_task: 'DEV-321',
          }),
        ],
      ),
    ).toEqual([])
  })

  test('revives the most recently seen mechanically stale note by id', () => {
    const existing =
      'canon audit: workshop canon/reference .agents/rules/canon.md:4 named path does not resolve'
    expect(
      decideCanonAuditNotes(
        [finding()],
        [
          note(existing, {
            id: 17,
            stale_at: '2026-09-24T12:00:00.000Z',
            stale_reason: 'anchor path no longer exists',
            last_seen_at: '2026-09-23T12:00:00.000Z',
          }),
          note(existing, {
            id: 29,
            stale_at: '2026-09-24T12:00:00.000Z',
            stale_reason: 'anchor content changed',
            last_seen_at: '2026-09-24T12:00:00.000Z',
          }),
        ],
      ),
    ).toEqual([
      {
        text: 'canon audit: workshop canon/reference .agents/rules/canon.md:12 named path does not resolve',
        sameAs: 29,
      },
    ])
  })

  test('retains readable projects and aggregates every project read failure', () => {
    expect(
      decideCanonAuditRun([
        {
          project: 'readable',
          path: '/projects/readable',
          findings: [finding()],
          notes: [],
          failures: [],
        },
        {
          project: 'no-canon',
          path: '/projects/no-canon',
          findings: null,
          notes: [],
          failures: ['cannot read canon for project "no-canon": unavailable'],
        },
        {
          project: 'no-notes',
          path: '/projects/no-notes',
          findings: [],
          notes: null,
          failures: ['cannot read note store for project "no-notes": unavailable'],
        },
      ]),
    ).toEqual({
      plans: [
        {
          project: 'readable',
          path: '/projects/readable',
          findings: 1,
          notes: [
            {
              text: 'canon audit: readable canon/reference .agents/rules/canon.md:12 named path does not resolve',
            },
          ],
        },
      ],
      failures: [
        'cannot read canon for project "no-canon": unavailable',
        'cannot read note store for project "no-notes": unavailable',
      ],
    })
  })
})
