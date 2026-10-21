import { describe, expect, test } from 'bun:test'
import { articleDraftSource } from './article-editor.tsx'

describe('articleDraftSource', () => {
  test('waits for the stored document and uses its unprojected body', () => {
    const pageDocument = { title: 'Guide', body: 'Visible section' }

    expect(articleDraftSource(pageDocument, undefined)).toBeNull()
    expect(
      articleDraftSource(pageDocument, {
        title: 'Guide',
        body: 'Visible section\n\n:::section{audience=architect}\nHidden section\n:::',
      }),
    ).toEqual({
      title: 'Guide',
      body: 'Visible section\n\n:::section{audience=architect}\nHidden section\n:::',
    })
  })
})
