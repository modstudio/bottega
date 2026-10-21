import { expect, test } from 'bun:test'
import { headingId, secondLevelHeadingIdsByLine, secondLevelHeadings } from './headings.ts'

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

test('a heading id is keyed by its source line, so in-page links reach every heading', () => {
  const body =
    '# doc\n\n- [audit](#workshop-doc-audit)\n\n## workshop doc\n\n```\n## not a heading\n```\n## workshop doc audit\n## workshop doc\n'
  expect([...secondLevelHeadingIdsByLine(body)]).toEqual([
    [5, 'workshop-doc'],
    [10, 'workshop-doc-audit'],
    [11, 'workshop-doc-2'],
  ])
})
