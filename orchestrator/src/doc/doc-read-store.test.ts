import { describe, expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import { getDocForAudienceStore, getDocStore, listDocMetadataStore } from './doc-read-store.ts'

describe('document read store', () => {
  test('audience reads project sections while author reads retain marks', async () => {
    const body = 'Everyone.\n:::section{audience="internal"}\nPrivate margin.\n:::\nAfter.'
    const created = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'sectioned',
      title: 'Sectioned',
      body,
      delivery: 'demand',
      audiences: ['internal', 'customer'],
      reason: 'exercise audience sections',
    })
    expect(getDocStore('global', null, created.slug)?.body).toBe(body)
    expect(getDocForAudienceStore('global', null, created.slug, 'customer')?.body).toBe(
      'Everyone.\nAfter.',
    )
    expect(getDocForAudienceStore('global', null, created.slug, 'internal')?.body).toContain(
      'Private margin.',
    )
    expect(listDocMetadataStore({ audience: 'customer', bodyMatch: 'Private margin' })).toEqual([])
    expect(
      listDocMetadataStore({ audience: 'internal', bodyMatch: 'Private margin' }),
    ).toHaveLength(1)
    expect(listDocMetadataStore({ audience: 'customer' })).toContainEqual(
      expect.objectContaining({
        slug: created.slug,
        summary: 'Everyone. After.',
        summarySource: 'derived',
      }),
    )
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: created.slug,
        title: created.title,
        body,
        audiences: ['customer'],
        reason: 'orphan the internal section',
        expectedRevision: created.revision!,
      }),
    ).rejects.toThrow('document does not list')
  })
})
