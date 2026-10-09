import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importDocs, setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import {
  docFileRelativePath,
  docSlugFromFilePath,
  exportDocFiles,
  importDocFiles,
} from './doc-files.ts'
import { exportDocs, getDoc } from './docs.ts'

const subjectDirectory = join('export', 'canon', 'alephbeis')

for (const [name, slug, relativePath, productionBreak] of [
  ['flat slug', 'principles', join('canon', 'alephbeis', 'principles.md'), 'omit the .md suffix'],
  [
    'slug with slashes',
    'contexts/code-architecture',
    join('canon', 'alephbeis', 'contexts', 'code-architecture.md'),
    'use only the slug basename',
  ],
  [
    'slug ending in .md',
    'contexts/code-architecture.md',
    join('canon', 'alephbeis', 'contexts', 'code-architecture.md.md'),
    'avoid appending a second .md suffix',
  ],
  [
    'slug starting with a dot directory',
    '.agents/contexts/code-architecture',
    join('canon', 'alephbeis', '.agents', 'contexts', 'code-architecture.md'),
    'drop the leading dot from a path segment',
  ],
] as const) {
  test(`${name} mapping mutation: ${productionBreak}`, () => {
    const path = docFileRelativePath({ scope: 'canon', subject: 'alephbeis', slug })
    expect(path).toBe(relativePath)
    expect(docSlugFromFilePath(subjectDirectory, join('export', path))).toBe(slug)
  })
}

test('path refusal mutation: allow an absolute or parent path through validation', () => {
  expect(() =>
    docFileRelativePath({ scope: 'canon', subject: 'alephbeis', slug: '../principles' }),
  ).toThrow('scope "canon", subject "alephbeis", slug "../principles"')
  expect(() =>
    docFileRelativePath({ scope: 'canon', subject: '../alephbeis', slug: 'principles' }),
  ).toThrow('scope "canon", subject "../alephbeis", slug "principles"')
  expect(() =>
    docFileRelativePath({ scope: 'canon', subject: 'alephbeis', slug: '/principles' }),
  ).toThrow('scope "canon", subject "alephbeis", slug "/principles"')
})

test('recursive round-trip mutation: scan only files directly inside the subject directory', async () => {
  const target = mkdtempSync(join(tmpdir(), 'orch-doc-nested-import-'))
  const docs = [
    {
      scope: 'canon' as const,
      subject: 'alephbeis',
      slug: '.agents/current.md',
      title: 'Current',
      status: 'current' as const,
      kind: 'article' as const,
      replacement_slug: null,
      body: 'new',
    },
    {
      scope: 'canon' as const,
      subject: 'alephbeis',
      slug: 'history/old',
      title: 'Old',
      status: 'superseded' as const,
      kind: 'working' as const,
      replacement_slug: '.agents/current.md',
      body: 'old',
    },
  ]
  try {
    expect(exportDocFiles(target, docs)).toBe(2)
    const imported: { slug: string; replacementSlug?: string | null }[] = []
    expect(
      await importDocFiles(target, async (doc) => {
        imported.push(doc)
      }),
    ).toBe(2)
    expect(imported.map(({ slug, replacementSlug }) => ({ slug, replacementSlug }))).toEqual([
      { slug: '.agents/current.md', replacementSlug: null },
      { slug: 'history/old', replacementSlug: '.agents/current.md' },
    ])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('import writes replacements before superseded documents regardless of file order', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'z-current',
    title: 'Current',
    body: 'new',
    kind: 'article',
  })
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'z-middle',
    title: 'Middle',
    body: 'middle',
    status: 'superseded',
    replacementSlug: 'z-current',
  })
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'a-old',
    title: 'Old',
    body: 'old',
    status: 'superseded',
    replacementSlug: 'z-middle',
  })
  const target = mkdtempSync(join(tmpdir(), 'orch-doc-status-import-'))
  try {
    expect(exportDocs(target)).toBe(3)
    db().exec('DELETE FROM doc')
    expect(await importDocs(target)).toBe(3)
    expect(getDoc('global', null, 'a-old')).toMatchObject({
      status: 'superseded',
      replacement_slug: 'z-middle',
    })
    expect(getDoc('global', null, 'z-middle')).toMatchObject({
      status: 'superseded',
      replacement_slug: 'z-current',
    })
    expect(getDoc('global', null, 'z-current')?.kind).toBe('article')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
