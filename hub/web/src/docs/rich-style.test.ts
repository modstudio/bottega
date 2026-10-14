import { expect, test } from 'bun:test'
import { forbiddenRichEditorDeclarations } from './rich-style.ts'

test('the style check refuses a typography declaration', () => {
  const findings = forbiddenRichEditorDeclarations(
    '.x {\n  font-size: 1rem;\n  caret-color: black;\n}\n',
  )
  expect(findings).toHaveLength(1)
  expect(findings[0]).toContain('font-size')
  expect(findings[0]).toContain('markdown.css')
})
