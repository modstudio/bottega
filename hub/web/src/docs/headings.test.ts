import { expect, test } from 'bun:test'
import { headingId, secondLevelHeadings } from './headings.ts'

test('second-level headings become contents entries with stable ids', () => {
  const body = `# Title\n\n## Open a task\n\ntext\n### Nested\n## Dispatch\n## Open a task\n`
  expect(secondLevelHeadings(body)).toEqual([
    { id: 'open-a-task', title: 'Open a task' },
    { id: 'dispatch', title: 'Dispatch' },
    { id: 'open-a-task-2', title: 'Open a task' },
  ])
  expect(headingId('On this page')).toBe('on-this-page')
})

test('fenced code is ignored and duplicate titles keep the same ids as the renderer', () => {
  const body = [
    '```',
    '## inside fence',
    '```',
    '~~~js',
    '## inside tildes',
    '~~~',
    '## Real',
    '## Real',
  ].join('\n')
  expect(secondLevelHeadings(body)).toEqual([
    { id: 'real', title: 'Real' },
    { id: 'real-2', title: 'Real' },
  ])
})

test('indented code is ignored', () => {
  expect(secondLevelHeadings('    ## indented\n\t## tabbed\n## Real\n')).toEqual([
    { id: 'real', title: 'Real' },
  ])
})
