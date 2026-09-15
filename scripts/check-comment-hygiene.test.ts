import { describe, expect, test } from 'bun:test'
import { checkCommentBody } from './check-comment-hygiene'

describe('comment hygiene', () => {
  const phrases = [
    'used to be',
    'used to have',
    'formerly',
    'back when',
    'previously',
    'was omitted',
    'this replaces',
    'this replaced',
    'the first draft',
    'restores the earlier',
    'restores the old',
    'restores the previous',
  ]

  for (const phrase of phrases) {
    test(`rejects ${phrase}`, () => {
      const comment = ['/', '/', ` ${phrase} behavior`].join('')
      expect(checkCommentBody('subject.ts', comment)).toEqual([
        { file: 'subject.ts', line: 1, phrase },
      ])
    })
  }

  test('finds a trailing comment', () => {
    const body = ['const value = 1 ', '/', '/', ' previously nullable'].join('')
    expect(checkCommentBody('subject.ts', body)).toHaveLength(1)
  })

  test('finds a block comment', () => {
    const body = ['/', '*\n * formerly nullable\n *', '/'].join('')
    expect(checkCommentBody('subject.ts', body)).toEqual([
      { file: 'subject.ts', line: 2, phrase: 'formerly' },
    ])
  })

  test('does not treat a URL string as a comment', () => {
    expect(checkCommentBody('subject.ts', 'const url = "https://example.test/previously"')).toEqual(
      [],
    )
  })

  test('does not reject the purpose sense of used to', () => {
    expect(checkCommentBody('subject.ts', '// the flag used to gate imports')).toEqual([])
  })
})
