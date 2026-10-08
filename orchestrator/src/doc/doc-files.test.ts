import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importDocs, setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { exportDocs, getDoc } from './docs.ts'

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
