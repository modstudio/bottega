import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { scoreNote } from './judgement.ts'

const trackResidue = trackedTestResidue()

const flags = (values: Record<string, string>) =>
  ({
    flag: (name: string) => values[name],
  }) as Parameters<typeof scoreNote>[0]

test('inline score notes accept ordinary punctuation and quoted strings', () => {
  expect(scoreNote(flags({ note: 'The households\' reports quote "caught value".' }))).toBe(
    'The households\' reports quote "caught value".',
  )
})

test('a note file is content and bypasses shell-fragment checks', () => {
  const root = trackResidue(join(dir, 'score-note-file'))
  mkdirSync(root, { recursive: true })
  const path = join(root, 'note.txt')
  writeFileSync(path, "The households' note says `caught value`.")
  expect(scoreNote(flags({ 'note-file': path }))).toBe("The households' note says `caught value`.")
})

test('a lone inline backtick is refused as an unexpanded shell fragment', () => {
  expect(() => scoreNote(flags({ note: '`' }))).toThrow('unexpanded shell fragment')
})
