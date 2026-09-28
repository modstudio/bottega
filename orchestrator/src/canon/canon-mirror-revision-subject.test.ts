import { expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { revisionRows } from './canon-mirror.ts'
import { mirrorRepository, registerManagedMirror } from './canon-mirror-ownership.fixture.ts'

test('revision rows ignore another project revision of the same canon path', async () => {
  const root = mirrorRepository('cm-revision-subject')
  try {
    await registerManagedMirror(root, 'cm-revision-subject')
    const other = join(root, 'other')
    mkdirSync(other)
    upsertProject({ name: 'cm-revision-other', path: other, canon: true, settings: {} })
    await setDoc({
      scope: 'canon',
      subject: 'cm-revision-other',
      slug: 'AGENTS.md',
      title: 'AGENTS.md',
      body: 'Foreign context.\n',
      reason: 'foreign revision',
      allowCanonBootstrap: true,
    })
    expect(revisionRows('cm-revision-subject', ['AGENTS.md'])[0]?.reason).toBe(
      'mirror ownership fixture',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
