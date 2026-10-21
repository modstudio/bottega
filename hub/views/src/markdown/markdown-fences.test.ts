import { expect, test } from 'bun:test'
import { fenceUse } from './markdown-fences.ts'

test('a mermaid fence is a diagram and does not take highlighting', () => {
  expect(fenceUse('mermaid')).toBe('diagram')
  expect(fenceUse('Mermaid')).toBe('diagram')
})

test('a fenced block with a language takes highlighting and is not a diagram', () => {
  expect(fenceUse('ts')).toBe('highlight')
  expect(fenceUse('typescript')).toBe('highlight')
})

test('a fenced block with no language is neither a diagram nor highlighted', () => {
  expect(fenceUse(undefined)).toBe('plain')
  expect(fenceUse('')).toBe('plain')
  expect(fenceUse('  ')).toBe('plain')
})
