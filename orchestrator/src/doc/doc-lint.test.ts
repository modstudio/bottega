import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { CanonLintInput } from '../canon/canon-lint.ts'
import {
  type DocReferenceProject,
  docLintRules,
  introducedDocFindings,
  lintDoc,
} from './doc-lint.ts'

const checkout = (paths: string[]): CanonLintInput => ({
  files: [],
  trackedPaths: paths,
  packageScripts: [],
  sourceTexts: paths.map((path) => ({ path, text: '' })),
})

const referenceProjects: DocReferenceProject[] = [
  {
    name: PLATFORM_NAME.toLowerCase(),
    stack: 'bun',
    checkout: checkout(['orchestrator/own.ts']),
  },
  { name: 'another-project', stack: 'other', checkout: checkout(['src/other.ts']) },
]

const doc = (body: string, extra: Partial<Parameters<typeof lintDoc>[0]> = {}) => ({
  scope: 'project',
  subject: PLATFORM_NAME.toLowerCase(),
  slug: 'guide',
  body,
  kind: 'working' as const,
  ...extra,
})

describe('stored document lint', () => {
  test('kind selects the prose rule set', () => {
    expect(docLintRules('working')).toEqual(['history', 'issue', 'numeral', 'date'])
    expect(docLintRules('article')).toEqual(['history', 'issue', 'date'])
  })

  test.each(['working', 'article'] as const)('%s distinguishes the two used-to senses', (kind) => {
    expect(lintDoc(doc('This field is used to compute the price.', { kind }))).toEqual([])
    expect(lintDoc(doc('The page used to show totals.', { kind }))).toEqual([
      expect.objectContaining({ rule: 'doc/history' }),
    ])
  })

  test('article permits a numeral while working refuses it', () => {
    expect(lintDoc(doc('There are 2 prices.', { kind: 'article' }))).toEqual([])
    expect(lintDoc(doc('There are 2 prices.'))).toEqual([
      expect.objectContaining({ rule: 'doc/numeral' }),
    ])
  })
  test('resume documents are exempt', () => {
    expect(lintDoc(doc('DEV-880 was formerly active on 2026-09-23.', { scope: 'resume' }))).toEqual(
      [],
    )
  })

  test('design records require their headings in order', () => {
    const body =
      '## What it is\n\nCurrent.\n\n## Build or buy\n\nBuilt.\n\n' +
      '## Why this design\n\nReason.\n\n## How it is measured\n\nRun the gate.\n'
    expect(lintDoc(doc(body, { slug: 'design-thing' }))).toEqual([
      expect.objectContaining({
        rule: 'doc/design-headings',
        message: expect.stringContaining('order'),
      }),
    ])
  })

  test('a clean design record passes with optional provisional in place', () => {
    const body =
      '## What it is\n\nCurrent behavior.\n\n## Why this design\n\nA direct rule.\n\n' +
      '## Build or buy\n\nBuilt locally.\n\n## Provisional\n\nExit when the gate reports coverage.\n\n' +
      '## How it is measured\n\nRun `bun run check`.\n'
    expect(lintDoc(doc(body, { slug: 'design-thing' }))).toEqual([])
  })

  test('a project document resolves paths against its registered project', () => {
    expect(
      lintDoc(
        doc('See `src/other.ts`.', {
          subject: 'another-project',
          referenceProjects,
        }),
      ),
    ).toEqual([])
  })

  test('a project document does not resolve paths against another project', () => {
    expect(lintDoc(doc('See `src/other.ts`.', { referenceProjects }))).toEqual([
      expect.objectContaining({ rule: 'doc/reference-path' }),
    ])
  })

  test('a global document resolves paths against any registered project', () => {
    expect(
      lintDoc(doc('See `src/other.ts`.', { scope: 'global', subject: null, referenceProjects })),
    ).toEqual([])
  })

  test('a missing project checkout produces one unverifiable finding', () => {
    expect(
      lintDoc(
        doc('See `src/one.ts` and `src/two.ts`.', {
          subject: 'missing-project',
          referenceProjects: [{ name: 'missing-project', stack: 'missing', checkout: null }],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        rule: 'doc/reference-unverifiable',
        message: expect.stringContaining('missing-project'),
      }),
    ])
  })

  test('a stack document resolves against projects on its stack', () => {
    expect(
      lintDoc(
        doc('See `src/other.ts`.', {
          scope: 'stack',
          subject: 'other',
          referenceProjects,
        }),
      ),
    ).toEqual([])
  })

  test('a stack with no available checkout produces one unverifiable finding', () => {
    expect(
      lintDoc(
        doc('See `src/one.ts` and `src/two.ts`.', {
          scope: 'stack',
          subject: 'missing',
          referenceProjects: [
            { name: 'missing-one', stack: 'missing', checkout: null },
            { name: 'other', stack: 'other', checkout: checkout(['src/other.ts']) },
          ],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        rule: 'doc/reference-unverifiable',
        message: expect.stringContaining('missing'),
      }),
    ])
  })

  test('the update ratchet compares rule and message without line numbers', () => {
    const baseline = lintDoc(doc('This was formerly different.'))
    const moved = lintDoc(doc('\nThis was formerly different.'))
    expect(introducedDocFindings(baseline, moved)).toEqual([])
    expect(
      introducedDocFindings(baseline, lintDoc(doc('This was formerly different.\nDEV-880.'))),
    ).toEqual([expect.objectContaining({ rule: 'doc/issue', message: 'contains a task key' })])
  })
})
