import { expect, test } from 'bun:test'
import { fittedDiagramWidth } from './markdown-mermaid.tsx'

test('a diagram slightly wider than its column is scaled to fit, a much wider one keeps its size', () => {
  expect(fittedDiagramWidth(600, 742)).toBe(600)
  expect(fittedDiagramWidth(900, 742)).toBe(742)
  expect(fittedDiagramWidth(1400, 742)).toBe(1400)
  expect(fittedDiagramWidth(900, 0)).toBe(900)
})
