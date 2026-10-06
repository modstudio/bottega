import { expect, test } from 'bun:test'
import { readingBody } from './body.ts'

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
