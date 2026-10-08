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
    slug: 'z-replacement',
    title: 'Replacement',
    body: 'new',
  })
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'a-superseded',
    title: 'Superseded',
    body: 'old',
    status: 'superseded',
    replacementSlug: 'z-replacement',
  })
  const target = mkdtempSync(join(tmpdir(), 'orch-doc-status-import-'))
  try {
    expect(exportDocs(target)).toBe(2)
    db().exec('DELETE FROM doc')
    expect(await importDocs(target)).toBe(2)
    expect(getDoc('global', null, 'a-superseded')).toMatchObject({
      status: 'superseded',
      replacement_slug: 'z-replacement',
    })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
