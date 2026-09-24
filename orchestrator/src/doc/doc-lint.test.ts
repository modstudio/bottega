import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { CanonLintInput } from '../canon/canon-lint.ts'
import { type DocReferenceProject, lintDoc } from './doc-lint.ts'

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
  ...extra,
})

describe('stored document lint', () => {
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
      '## What it is\n\nCurrent behaviour.\n\n## Why this design\n\nA direct rule.\n\n' +
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
})
