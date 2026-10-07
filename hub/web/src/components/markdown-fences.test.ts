import { expect, test } from 'bun:test'
import { fenceUse, markdownImportNeeds } from './markdown-fences.ts'

test('a mermaid fence is a diagram and does not take highlighting', () => {
  expect(fenceUse('mermaid')).toBe('diagram')
  expect(fenceUse('Mermaid')).toBe('diagram')
  expect(markdownImportNeeds('```mermaid\nflowchart LR\nA-->B\n```')).toEqual({
    mermaid: true,
    highlight: false,
  })
})

test('a fenced block with a language takes highlighting and is not a diagram', () => {
  expect(fenceUse('ts')).toBe('highlight')
  expect(fenceUse('typescript')).toBe('highlight')
  expect(markdownImportNeeds('```ts\nconst n = 1\n```')).toEqual({
    mermaid: false,
    highlight: true,
  })
})

test('a fenced block with no language is neither a diagram nor highlighted', () => {
  expect(fenceUse(undefined)).toBe('plain')
  expect(fenceUse('')).toBe('plain')
  expect(fenceUse('  ')).toBe('plain')
  expect(markdownImportNeeds('```\nplain source\n```')).toEqual({
    mermaid: false,
    highlight: false,
  })
})

test('a document with neither a diagram nor a language fence requests neither import', () => {
  const body = [
    '# Title',
    '',
    'A paragraph with `inline` code.',
    '',
    '> [!NOTE]',
    '> A callout is not a fence.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '- [ ] a task',
    '',
    '    indented code is not a fence',
  ].join('\n')
  expect(markdownImportNeeds(body)).toEqual({ mermaid: false, highlight: false })
})

test('tilde fences and mixed documents follow the same rules', () => {
  expect(markdownImportNeeds('~~~js\ntrue\n~~~')).toEqual({ mermaid: false, highlight: true })
  expect(
    markdownImportNeeds('```mermaid\nflowchart TB\nA-->B\n```\n\n```ts\nconst n = 1\n```'),
  ).toEqual({ mermaid: true, highlight: true })
})
