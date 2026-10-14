#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { forbiddenRichEditorDeclarations } from '../hub/web/src/docs/rich-style.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FILE = 'hub/web/src/styles/doc-editor-rich.css'

const findings = forbiddenRichEditorDeclarations(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
if (!findings.length) {
  console.log('check-doc-editor-rich-style: ok')
  process.exit(0)
}
console.error(`${FILE}: text styling belongs in markdown.css`)
for (const finding of findings) console.error(`  ${finding}`)
process.exit(1)
