import { describe, expect, test } from 'bun:test'
import { docsForRun, listDocRevisions, restoreDoc, setDoc, setDocStatus } from './docs.ts'

describe('document status', () => {
  test('validates replacements, excludes drafts from delivery, and restores snapshots', async () => {
    const replacement = await setDoc({
      scope: 'job',
      subject: 'file-question',
      slug: 'replacement-guide',
      title: 'Replacement guide',
      body: 'Replacement.',
      delivery: 'inject',
      reason: 'create replacement',
    })
    const draft = await setDoc({
      scope: 'job',
      subject: 'file-question',
      slug: 'draft-guide',
      title: 'Draft guide',
      body: 'Draft.',
      delivery: 'inject',
      status: 'draft',
      reason: 'create draft',
    })
    expect(
      docsForRun({ job: 'file-question', cwd: '/elsewhere' }).map((doc) => doc.slug),
    ).not.toContain(draft.slug)
    await expect(
      setDocStatus('job', 'file-question', draft.slug, 'superseded', 'missing-guide', {
        reason: 'supersede draft',
      }),
    ).rejects.toThrow('does not exist in the same scope and subject')
    const superseded = await setDocStatus(
      'job',
      'file-question',
      draft.slug,
      'superseded',
      replacement.slug,
      { reason: 'supersede draft' },
    )
    expect(superseded.replacement_slug).toBe(replacement.slug)
    const draftRevision = listDocRevisions('job', 'file-question', draft.slug).at(-1)!
    const restored = await restoreDoc('job', 'file-question', draft.slug, draftRevision.id, {
      reason: 'restore draft state',
      expectedRevision: superseded.revision!,
    })
    expect(restored).toMatchObject({ status: 'draft', replacement_slug: null })
  })
})
