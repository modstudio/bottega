import { describe, expect, test } from 'bun:test'
import {
  chunkDoc,
  chunkText,
  docIdentity,
  isTestCodePath,
  splitChunksToModelLimit,
} from './chunks.ts'

test('recognizes code test files and test directory segments', () => {
  expect(isTestCodePath('src/example.test.ts')).toBe(true)
  expect(isTestCodePath('src/example.test.tsx')).toBe(true)
  expect(isTestCodePath('src/test/example.ts')).toBe(true)
  expect(isTestCodePath('test/example.ts')).toBe(true)
  expect(isTestCodePath('src/testing/example.ts')).toBe(false)
  expect(isTestCodePath('src/example.ts')).toBe(false)
})

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
    const [chunk] = chunkDoc({
      scope: 'project',
      subject: 'subject',
      slug: 'retrieval-design',
      title: 'Retrieval design',
      body: 'The measured design.',
      status: 'current',
    })

    expect(chunk?.identity).toEqual({
      kind: 'doc',
      scope: 'project',
      subject: 'subject',
      slug: 'retrieval-design',
    })
    expect(chunk?.path).toBe('doc:project/subject/retrieval-design')
    expect(docIdentity({ scope: 'global', subject: null, slug: 'shared-rule' })).toBe(
      'doc:global/_/shared-rule',
    )
  })

  test('splits sections while inheriting the title and heading path', () => {
    const chunks = chunkDoc({
      scope: 'project',
      subject: 'subject',
      slug: 'headed',
      title: 'Whole document',
      body: '## Parent\nparent text\n\n### Child\nchild text\n\n## Sibling\nsibling text',
      status: 'current',
    })

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      '# Whole document\n\n## Parent\n\nparent text',
      '# Whole document\n\n## Parent\n\n### Child\n\nchild text',
      '# Whole document\n\n## Sibling\n\nsibling text',
    ])
  })

  test('splits long sections at paragraphs, then long paragraphs at lines', () => {
    const paragraph = 'paragraph '.repeat(150).trim()
    const longLines = Array.from(
      { length: 8 },
      (_, index) => `${index} ${'line '.repeat(55)}`,
    ).join('\n')
    const chunks = chunkDoc({
      scope: 'project',
      subject: 'subject',
      slug: 'long-doc',
      title: 'Long doc',
      body: `## Details\n${paragraph}\n\n${paragraph}\n\n${longLines}`,
      status: 'current',
    })

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.text.startsWith('# Long doc\n\n## Details\n\n'))).toBe(
      true,
    )
    expect(chunks.every((chunk) => chunk.text.length <= 2_000)).toBe(true)
  })

  test('recounts exact prefixed documents and recursively splits oversized chunks by line', async () => {
    const [chunk] = chunkText('source.ts', ['one', 'two', 'three', 'four'].join('\n'))
    const counted: string[] = []
    const chunks = await splitChunksToModelLimit([chunk!], async (document) => {
      counted.push(document)
      return { count: document.split('\n').length, maxModelLength: 3 }
    })

    expect(counted[0]).toBe('source.ts:1\none\ntwo\nthree\nfour')
    expect(chunks.map(({ startLine, endLine, text }) => ({ startLine, endLine, text }))).toEqual([
      { startLine: 1, endLine: 2, text: 'one\ntwo' },
      { startLine: 3, endLine: 4, text: 'three\nfour' },
    ])
  })
})
