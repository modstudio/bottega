import { describe, expect, test } from 'bun:test'
import { chunkDoc, chunkText, docIdentity } from './chunks.ts'

describe('chunkText', () => {
  test('bounds retrieval units and overlaps their context', () => {
    const chunks = chunkText('source.ts', ['one', 'two', 'three', 'four', 'five'].join('\n'), 3, 1)

    expect(chunks.map(({ startLine, endLine, text }) => ({ startLine, endLine, text }))).toEqual([
      { startLine: 1, endLine: 3, text: 'one\ntwo\nthree' },
      { startLine: 3, endLine: 5, text: 'three\nfour\nfive' },
    ])
  })

  test('rejects an overlap that cannot advance', () => {
    expect(() => chunkText('source.ts', 'body', 10, 10)).toThrow(
      'chunk size must exceed a non-negative overlap',
    )
  })

  test('doc chunks carry their scope, subject and slug identity', () => {
    const [chunk] = chunkDoc(
      {
        scope: 'project',
        subject: 'bottega',
        slug: 'retrieval-design',
        title: 'Retrieval design',
        body: 'The measured design.',
      },
      10,
      1,
    )

    expect(chunk?.identity).toEqual({
      kind: 'doc',
      scope: 'project',
      subject: 'bottega',
      slug: 'retrieval-design',
    })
    expect(chunk?.path).toBe('doc:project/bottega/retrieval-design')
    expect(docIdentity({ scope: 'global', subject: null, slug: 'shared-rule' })).toBe(
      'doc:global/_/shared-rule',
    )
  })
})
