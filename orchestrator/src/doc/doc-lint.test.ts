import { describe, expect, test } from 'bun:test'
import { lintDoc } from './doc-lint.ts'

const doc = (body: string, extra: Partial<Parameters<typeof lintDoc>[0]> = {}) => ({
  scope: 'project',
  subject: 'bottega',
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
    expect(lintDoc(doc(body, { slug: 'design/thing' }))).toEqual([
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
    expect(lintDoc(doc(body, { slug: 'design/thing' }))).toEqual([])
  })
})
