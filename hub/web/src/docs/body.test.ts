import { expect, test } from 'bun:test'
import { leadingHeading, paneTitle, readingBody } from './body.ts'

test('the pane shows the body heading as the title and the stored title beneath it', () => {
  expect(paneTitle('Product philosophy: what it is for', '# Product philosophy\n\nText.')).toEqual({
    title: 'Product philosophy',
    lede: 'Product philosophy: what it is for',
  })
})

test('the pane shows the stored title alone when the body has no heading or repeats it', () => {
  expect(paneTitle('Install', 'Run the installer.')).toEqual({ title: 'Install', lede: null })
  expect(paneTitle('Install', '# Install\n\nRun it.')).toEqual({ title: 'Install', lede: null })
})

test('a leading level-one heading is dropped so the pane title is the only one', () => {
  expect(readingBody('# Getting started\n\nInstall the tool.\n')).toBe('\nInstall the tool.\n')
  expect(readingBody('\n\n# Title\n\nBody')).toBe('\nBody')
  expect(readingBody('# Title')).toBe('')
})

test('a body that does not begin with a level-one heading is unchanged', () => {
  expect(readingBody('## Open a task\n\nEvery piece of work carries a key.\n')).toBe(
    '## Open a task\n\nEvery piece of work carries a key.\n',
  )
  expect(readingBody('Intro\n\n# Later')).toBe('Intro\n\n# Later')
  expect(readingBody('#No-space heading\n\nBody')).toBe('#No-space heading\n\nBody')
  expect(readingBody('')).toBe('')
})

test('the leading heading text is the line readingBody removes, without closing hashes', () => {
  expect(leadingHeading('\n\n# Product philosophy ##\n\nBody.')).toBe('Product philosophy')
  expect(leadingHeading('# Title\n\nText.')).toBe('Title')
})

test('there is no leading heading when the body opens with prose or a deeper heading', () => {
  expect(leadingHeading('Intro.\n\n# Later')).toBeNull()
  expect(leadingHeading('## Section\n')).toBeNull()
  expect(leadingHeading('#No-space heading')).toBeNull()
  expect(leadingHeading('')).toBeNull()
})
